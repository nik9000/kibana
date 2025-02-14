/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { BehaviorSubject } from 'rxjs';
import {
  SingleMetricJobCreator,
  MultiMetricJobCreator,
  isMultiMetricJobCreator,
  PopulationJobCreator,
  isPopulationJobCreator,
} from '../job_creator';
import { mlResultsService } from '../../../../services/results_service';
import { MlTimeBuckets } from '../../../../util/ml_time_buckets';
import { getSeverityType } from '../../../../../common/util/anomaly_utils';
import { ANOMALY_SEVERITY } from '../../../../../common/constants/anomalies';
import { getScoresByRecord } from './searches';
import { JOB_TYPE } from '../job_creator/util/constants';
import { ChartLoader } from '../chart_loader';

export interface Results {
  progress: number;
  model: Record<number, ModelItem[]>;
  anomalies: Record<number, Anomaly[]>;
}

export interface ModelItem {
  time: number;
  actual: number;
  modelUpper: number;
  modelLower: number;
}

export interface Anomaly {
  time: number;
  value: number;
  severity: ANOMALY_SEVERITY;
}

const emptyModelItem = {
  time: 0,
  actual: 0,
  modelUpper: 0,
  modelLower: 0,
};

interface SplitFieldWithValue {
  name: string;
  value: string;
}

const LAST_UPDATE_DELAY_MS = 500;

export type ResultsSubscriber = (results: Results) => void;

type AnyJobCreator = SingleMetricJobCreator | MultiMetricJobCreator | PopulationJobCreator;

export class ResultsLoader {
  private _results$: BehaviorSubject<Results>;
  private _resultsSearchRunning = false;
  private _jobCreator: AnyJobCreator;
  private _chartInterval: MlTimeBuckets;
  private _lastModelTimeStamp: number = 0;
  private _lastResultsTimeout: any = null;
  private _chartLoader: ChartLoader;

  private _results: Results = {
    progress: 0,
    model: [],
    anomalies: [],
  };

  private _detectorSplitFieldFilters: SplitFieldWithValue | null = null;
  private _splitFieldFiltersLoaded: boolean = false;

  constructor(jobCreator: AnyJobCreator, chartInterval: MlTimeBuckets, chartLoader: ChartLoader) {
    this._jobCreator = jobCreator;
    this._chartInterval = chartInterval;
    this._results$ = new BehaviorSubject(this._results);
    this._chartLoader = chartLoader;

    jobCreator.subscribeToProgress(this.progressSubscriber);
  }

  progressSubscriber = async (progress: number) => {
    if (
      this._resultsSearchRunning === false &&
      (progress - this._results.progress > 5 || progress === 100)
    ) {
      if (this._splitFieldFiltersLoaded === false) {
        this._splitFieldFiltersLoaded = true;
        // load detector field filters if this is the first run.
        await this._populateDetectorSplitFieldFilters();
      }

      this._updateData(progress, false);

      if (progress === 100) {
        // after the job has finished, do one final update
        // a while after the last 100% has been received.
        // note, there may be multiple 100% progresses sent as they will only stop once the
        // datafeed has stopped.
        clearTimeout(this._lastResultsTimeout);
        this._lastResultsTimeout = setTimeout(() => {
          this._updateData(progress, true);
        }, LAST_UPDATE_DELAY_MS);
      }
    }
  };

  private async _updateData(progress: number, fullRefresh: boolean) {
    this._resultsSearchRunning = true;

    if (fullRefresh === true) {
      this._clearResults();
    }
    this._results.progress = progress;

    const getAnomalyData =
      this._jobCreator.type === JOB_TYPE.SINGLE_METRIC
        ? () => this._loadJobAnomalyData(0)
        : () => this._loadDetectorsAnomalyData();

    // TODO - load more that one model
    const [model, anomalies] = await Promise.all([this._loadModelData(0), getAnomalyData()]);
    this._results.model = model;
    this._results.anomalies = anomalies;

    this._resultsSearchRunning = false;
    this._results$.next(this._results);
  }

  public subscribeToResults(func: ResultsSubscriber) {
    return this._results$.subscribe(func);
  }

  public get progress() {
    return this._results.progress;
  }

  private _clearResults() {
    this._results.model = {};
    this._results.anomalies = {};
    this._results.progress = 0;
    this._lastModelTimeStamp = 0;
  }

  private async _loadModelData(dtrIndex: number): Promise<Record<number, ModelItem[]>> {
    if (this._jobCreator.modelPlot === false) {
      return [];
    }

    const agg = this._jobCreator.getAggregation(dtrIndex);
    if (agg === null) {
      return { [dtrIndex]: [emptyModelItem] };
    }
    const resp = await mlResultsService.getModelPlotOutput(
      this._jobCreator.jobId,
      dtrIndex,
      [],
      this._lastModelTimeStamp,
      this._jobCreator.end,
      `${this._chartInterval.getInterval().asMilliseconds()}ms`,
      agg.mlModelPlotAgg
    );

    return this._createModel(resp, dtrIndex);
  }

  private _createModel(resp: any, dtrIndex: number): Record<number, ModelItem[]> {
    if (this._results.model[dtrIndex] === undefined) {
      this._results.model[dtrIndex] = [];
    }

    // create ModelItem list from search results
    const model = Object.entries(resp.results).map(
      ([time, modelItems]) =>
        ({
          time: +time,
          ...modelItems,
        } as ModelItem)
    );

    if (model.length > 10) {
      // discard the last 5 buckets in the previously loaded model to avoid partial results
      // set the _lastModelTimeStamp to be 5 buckets behind so we load the correct
      // section of results next time.
      this._lastModelTimeStamp = model[model.length - 5].time;
      for (let i = 0; i < 5; i++) {
        this._results.model[dtrIndex].pop();
      }
    }

    // return a new array from the old and new model
    return { [dtrIndex]: this._results.model[dtrIndex].concat(model) };
  }

  private async _loadJobAnomalyData(dtrIndex: number): Promise<Record<number, Anomaly[]>> {
    const resp = await mlResultsService.getScoresByBucket(
      [this._jobCreator.jobId],
      this._jobCreator.start,
      this._jobCreator.end,
      `${this._chartInterval.getInterval().asMilliseconds()}ms`,
      1
    );

    const results = resp.results[this._jobCreator.jobId];
    if (results === undefined) {
      return [];
    }

    const anomalies: Record<number, Anomaly[]> = {};
    anomalies[0] = Object.entries(results).map(
      ([time, value]) =>
        ({ time: +time, value, severity: getSeverityType(value as number) } as Anomaly)
    );
    return anomalies;
  }

  private async _loadDetectorsAnomalyData(): Promise<Record<number, Anomaly[]>> {
    const resp = await getScoresByRecord(
      this._jobCreator.jobId,
      this._jobCreator.start,
      this._jobCreator.end,
      `${this._chartInterval.getInterval().asMilliseconds()}ms`,
      this._detectorSplitFieldFilters
    );

    const anomalies: Record<number, Anomaly[]> = {};
    Object.entries(resp.results).forEach(([dtrIdx, results]) => {
      anomalies[+dtrIdx] = results.map(
        r => ({ ...r, severity: getSeverityType(r.value as number) } as Anomaly)
      );
    });
    return anomalies;
  }

  private async _populateDetectorSplitFieldFilters() {
    if (isMultiMetricJobCreator(this._jobCreator) || isPopulationJobCreator(this._jobCreator)) {
      if (this._jobCreator.splitField !== null) {
        const fieldValues = await this._chartLoader.loadFieldExampleValues(
          this._jobCreator.splitField
        );
        if (fieldValues.length > 0) {
          this._detectorSplitFieldFilters = {
            name: this._jobCreator.splitField.name,
            value: fieldValues[0],
          };
        }
        return;
      }
    }
    this._detectorSplitFieldFilters = null;
  }
}
