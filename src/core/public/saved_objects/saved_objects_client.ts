/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { cloneDeep, pick, throttle } from 'lodash';
import { resolve as resolveUrl } from 'url';

import {
  SavedObject,
  SavedObjectAttributes,
  SavedObjectReference,
  SavedObjectsClientContract as SavedObjectsApi,
  SavedObjectsFindOptions as SavedObjectFindOptionsServer,
  SavedObjectsMigrationVersion,
} from '../../server';

// TODO: Migrate to an error modal powered by the NP?
import {
  isAutoCreateIndexError,
  showAutoCreateIndexErrorPage,
} from '../../../legacy/ui/public/error_auto_create_index/error_auto_create_index';
import { SimpleSavedObject } from './simple_saved_object';
import { HttpFetchOptions, HttpServiceBase } from '../http';

type SavedObjectsFindOptions = Omit<SavedObjectFindOptionsServer, 'namespace' | 'sortOrder'>;

type PromiseType<T extends Promise<any>> = T extends Promise<infer U> ? U : never;

/** @public */
export interface SavedObjectsCreateOptions {
  /**
   * (Not recommended) Specify an id instead of having the saved objects service generate one for you.
   */
  id?: string;
  /** If a document with the given `id` already exists, overwrite it's contents (default=false). */
  overwrite?: boolean;
  /** {@inheritDoc SavedObjectsMigrationVersion} */
  migrationVersion?: SavedObjectsMigrationVersion;
  references?: SavedObjectReference[];
}

/**
 * @param type - Create a SavedObject of the given type
 * @param attributes - Create a SavedObject with the given attributes
 *
 * @public
 */
export interface SavedObjectsBulkCreateObject<
  T extends SavedObjectAttributes = SavedObjectAttributes
> extends SavedObjectsCreateOptions {
  type: string;
  attributes: T;
}

/** @public */
export interface SavedObjectsBulkCreateOptions {
  /** If a document with the given `id` already exists, overwrite it's contents (default=false). */
  overwrite?: boolean;
}

/** @public */
export interface SavedObjectsUpdateOptions {
  version?: string;
  /** {@inheritDoc SavedObjectsMigrationVersion} */
  migrationVersion?: SavedObjectsMigrationVersion;
  references?: SavedObjectReference[];
}

/** @public */
export interface SavedObjectsBatchResponse<
  T extends SavedObjectAttributes = SavedObjectAttributes
> {
  savedObjects: Array<SimpleSavedObject<T>>;
}

/**
 * Return type of the Saved Objects `find()` method.
 *
 * *Note*: this type is different between the Public and Server Saved Objects
 * clients.
 *
 * @public
 */
export interface SavedObjectsFindResponsePublic<
  T extends SavedObjectAttributes = SavedObjectAttributes
> extends SavedObjectsBatchResponse<T> {
  total: number;
  perPage: number;
  page: number;
}

interface BatchQueueEntry {
  type: string;
  id: string;
  resolve: <T extends SavedObjectAttributes>(value: SimpleSavedObject<T> | SavedObject<T>) => void;
  reject: (reason?: any) => void;
}

const join = (...uriComponents: Array<string | undefined>) =>
  uriComponents
    .filter((comp): comp is string => Boolean(comp))
    .map(encodeURIComponent)
    .join('/');

/**
 * Interval that requests are batched for
 * @type {integer}
 */
const BATCH_INTERVAL = 100;

const API_BASE_URL = '/api/saved_objects/';

/**
 * SavedObjectsClientContract as implemented by the {@link SavedObjectsClient}
 *
 * @public
 */
export type SavedObjectsClientContract = PublicMethodsOf<SavedObjectsClient>;

/**
 * Saved Objects is Kibana's data persisentence mechanism allowing plugins to
 * use Elasticsearch for storing plugin state. The client-side
 * SavedObjectsClient is a thin convenience library around the SavedObjects
 * HTTP API for interacting with Saved Objects.
 *
 * @public
 */
export class SavedObjectsClient {
  private http: HttpServiceBase;
  private batchQueue: BatchQueueEntry[];

  /**
   * Throttled processing of get requests into bulk requests at 100ms interval
   */
  private processBatchQueue = throttle(
    () => {
      const queue = cloneDeep(this.batchQueue);
      this.batchQueue = [];

      this.bulkGet(queue)
        .then(({ savedObjects }) => {
          queue.forEach(queueItem => {
            const foundObject = savedObjects.find(savedObject => {
              return savedObject.id === queueItem.id && savedObject.type === queueItem.type;
            });

            if (!foundObject) {
              return queueItem.resolve(this.createSavedObject(pick(queueItem, ['id', 'type'])));
            }

            queueItem.resolve(foundObject);
          });
        })
        .catch(err => {
          queue.forEach(queueItem => {
            queueItem.reject(err);
          });
        });
    },
    BATCH_INTERVAL,
    { leading: false }
  );

  /** @internal */
  constructor(http: HttpServiceBase) {
    this.http = http;
    this.batchQueue = [];
  }

  /**
   * Persists an object
   *
   * @param type
   * @param attributes
   * @param options
   * @returns
   */
  public create = <T extends SavedObjectAttributes>(
    type: string,
    attributes: T,
    options: SavedObjectsCreateOptions = {}
  ): Promise<SimpleSavedObject<T>> => {
    if (!type || !attributes) {
      return Promise.reject(new Error('requires type and attributes'));
    }

    const path = this.getPath([type, options.id]);
    const query = {
      overwrite: options.overwrite,
    };

    const createRequest: Promise<SavedObject<T>> = this.savedObjectsFetch(path, {
      method: 'POST',
      query,
      body: JSON.stringify({
        attributes,
        migrationVersion: options.migrationVersion,
        references: options.references,
      }),
    });

    return createRequest
      .then(resp => this.createSavedObject(resp))
      .catch((error: object) => {
        if (isAutoCreateIndexError(error)) {
          showAutoCreateIndexErrorPage();
        }

        throw error;
      });
  };

  /**
   * Creates multiple documents at once
   *
   * @param {array} objects - [{ type, id, attributes, references, migrationVersion }]
   * @param {object} [options={}]
   * @property {boolean} [options.overwrite=false]
   * @returns The result of the create operation containing created saved objects.
   */
  public bulkCreate = (
    objects: SavedObjectsBulkCreateObject[] = [],
    options: SavedObjectsBulkCreateOptions = { overwrite: false }
  ) => {
    const path = this.getPath(['_bulk_create']);
    const query = { overwrite: options.overwrite };

    const request: ReturnType<SavedObjectsApi['bulkCreate']> = this.savedObjectsFetch(path, {
      method: 'POST',
      query,
      body: JSON.stringify(objects),
    });
    return request.then(resp => {
      resp.saved_objects = resp.saved_objects.map(d => this.createSavedObject(d));
      return renameKeys<
        PromiseType<ReturnType<SavedObjectsApi['bulkCreate']>>,
        SavedObjectsBatchResponse
      >({ saved_objects: 'savedObjects' }, resp) as SavedObjectsBatchResponse;
    });
  };

  /**
   * Deletes an object
   *
   * @param type
   * @param id
   * @returns
   */
  public delete = (type: string, id: string): ReturnType<SavedObjectsApi['delete']> => {
    if (!type || !id) {
      return Promise.reject(new Error('requires type and id'));
    }

    return this.savedObjectsFetch(this.getPath([type, id]), { method: 'DELETE' });
  };

  /**
   * Search for objects
   *
   * @param {object} [options={}]
   * @property {string} options.type
   * @property {string} options.search
   * @property {string} options.searchFields - see Elasticsearch Simple Query String
   *                                        Query field argument for more information
   * @property {integer} [options.page=1]
   * @property {integer} [options.perPage=20]
   * @property {array} options.fields
   * @property {object} [options.hasReference] - { type, id }
   * @returns A find result with objects matching the specified search.
   */
  public find = <T extends SavedObjectAttributes>(
    options: SavedObjectsFindOptions = {}
  ): Promise<SavedObjectsFindResponsePublic<T>> => {
    const path = this.getPath(['_find']);
    const renameMap = {
      defaultSearchOperator: 'default_search_operator',
      fields: 'fields',
      hasReference: 'has_reference',
      page: 'page',
      perPage: 'per_page',
      search: 'search',
      searchFields: 'search_fields',
      sortField: 'sort_field',
      type: 'type',
    };

    const renamedQuery = renameKeys<SavedObjectsFindOptions, any>(renameMap, options);
    const query = pick.apply(null, [renamedQuery, ...Object.values<string>(renameMap)]);

    const request: ReturnType<SavedObjectsApi['find']> = this.savedObjectsFetch(path, {
      method: 'GET',
      query,
    });
    return request.then(resp => {
      resp.saved_objects = resp.saved_objects.map(d => this.createSavedObject(d));
      return renameKeys<
        PromiseType<ReturnType<SavedObjectsApi['find']>>,
        SavedObjectsFindResponsePublic
      >(
        {
          saved_objects: 'savedObjects',
          total: 'total',
          per_page: 'perPage',
          page: 'page',
        },
        resp
      ) as SavedObjectsFindResponsePublic<T>;
    });
  };

  /**
   * Fetches a single object
   *
   * @param {string} type
   * @param {string} id
   * @returns The saved object for the given type and id.
   */
  public get = <T extends SavedObjectAttributes>(
    type: string,
    id: string
  ): Promise<SimpleSavedObject<T>> => {
    if (!type || !id) {
      return Promise.reject(new Error('requires type and id'));
    }

    return new Promise((resolve, reject) => {
      this.batchQueue.push({ type, id, resolve, reject } as BatchQueueEntry);
      this.processBatchQueue();
    });
  };

  /**
   * Returns an array of objects by id
   *
   * @param {array} objects - an array ids, or an array of objects containing id and optionally type
   * @returns The saved objects with the given type and ids requested
   * @example
   *
   * bulkGet([
   *   { id: 'one', type: 'config' },
   *   { id: 'foo', type: 'index-pattern' }
   * ])
   */
  public bulkGet = (objects: Array<{ id: string; type: string }> = []) => {
    const path = this.getPath(['_bulk_get']);
    const filteredObjects = objects.map(obj => pick(obj, ['id', 'type']));

    const request: ReturnType<SavedObjectsApi['bulkGet']> = this.savedObjectsFetch(path, {
      method: 'POST',
      body: JSON.stringify(filteredObjects),
    });
    return request.then(resp => {
      resp.saved_objects = resp.saved_objects.map(d => this.createSavedObject(d));
      return renameKeys<
        PromiseType<ReturnType<SavedObjectsApi['bulkGet']>>,
        SavedObjectsBatchResponse
      >({ saved_objects: 'savedObjects' }, resp) as SavedObjectsBatchResponse;
    });
  };

  /**
   * Updates an object
   *
   * @param {string} type
   * @param {string} id
   * @param {object} attributes
   * @param {object} options
   * @prop {integer} options.version - ensures version matches that of persisted object
   * @prop {object} options.migrationVersion - The optional migrationVersion of this document
   * @returns
   */
  public update<T extends SavedObjectAttributes>(
    type: string,
    id: string,
    attributes: T,
    { version, migrationVersion, references }: SavedObjectsUpdateOptions = {}
  ): Promise<SimpleSavedObject<T>> {
    if (!type || !id || !attributes) {
      return Promise.reject(new Error('requires type, id and attributes'));
    }

    const path = this.getPath([type, id]);
    const body = {
      attributes,
      migrationVersion,
      references,
      version,
    };

    return this.savedObjectsFetch(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    }).then((resp: SavedObject<T>) => {
      return this.createSavedObject(resp);
    });
  }

  private createSavedObject<T extends SavedObjectAttributes>(
    options: SavedObject<T>
  ): SimpleSavedObject<T> {
    return new SimpleSavedObject(this, options);
  }

  private getPath(path: Array<string | undefined>): string {
    return resolveUrl(API_BASE_URL, join(...path));
  }

  /**
   * To ensure we don't break backwards compatibility, savedObjectsFetch keeps
   * the old kfetch error format of `{res: {status: number}}` whereas `http.fetch`
   * uses `{response: {status: number}}`.
   */
  private savedObjectsFetch(path: string, { method, query, body }: HttpFetchOptions) {
    return this.http.fetch(path, { method, query, body }).catch(err => {
      const kfetchError = Object.assign(err, { res: err.response });
      delete kfetchError.response;
      return Promise.reject(kfetchError);
    });
  }
}

/**
 * Returns a new object with the own properties of `obj`, but the
 * keys renamed according to the `keysMap`.
 *
 * @param keysMap - a map of the form `{oldKey: newKey}`
 * @param obj - the object whose own properties will be renamed
 */
const renameKeys = <T extends Record<string, any>, U extends Record<string, any>>(
  keysMap: Record<keyof T, keyof U>,
  obj: Record<string, any>
) =>
  Object.keys(obj).reduce((acc, key) => {
    return {
      ...acc,
      ...{ [keysMap[key] || key]: obj[key] },
    };
  }, {});
