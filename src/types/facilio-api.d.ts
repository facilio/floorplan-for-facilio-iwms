/** @facilio/api ships no type declarations — minimal ambient shim for what this app uses. */
declare module '@facilio/api' {
  import type { AxiosInstance } from 'axios';

  export interface FacilioApiConfig {
    cacheTimeout?: number | null;
    uniqueKey?: string | null;
    _axios?: AxiosInstance;
    _newV3?: boolean;
  }

  export function setConfig(config: FacilioApiConfig): void;
  export function setInstance(instance: AxiosInstance): void;
  export function getInstance(): AxiosInstance;

  export interface FacilioApiResult<T = any> {
    data: T | null;
    error: { code?: number | string; message?: string; isCancelled?: boolean } | null;
    [key: string]: any;
  }

  export interface FacilioApiListResult<T = any> extends FacilioApiResult<T[]> {
    list: T[] | null;
  }

  export const API: {
    get<T = any>(url: string, params?: Record<string, unknown>, opts?: Record<string, unknown>): Promise<FacilioApiResult<T>>;
    post<T = any>(url: string, body?: unknown, opts?: Record<string, unknown>): Promise<FacilioApiResult<T>>;
    put<T = any>(url: string, body?: unknown, opts?: Record<string, unknown>): Promise<FacilioApiResult<T>>;
    patch<T = any>(url: string, body?: unknown, opts?: Record<string, unknown>): Promise<FacilioApiResult<T>>;
    delete<T = any>(url: string, body?: unknown, opts?: Record<string, unknown>): Promise<FacilioApiResult<T>>;
    /**
     * The record's own fields go under `data` when SENDING (e.g. `{ data: { name, fileId } }`).
     * The RESOLVED result, though, nests the record under `res[moduleName]` (e.g.
     * `res.floor`/`res.indoorfloorplan`), NOT `res.data` — confirmed live against
     * `fetchRecord`/`createRecord`/`updateRecord`. `res.data` is always undefined; a `.data`
     * check there silently looks like "not found" instead of a real error.
     */
    createRecord<T = any>(moduleName: string, params: { data: Record<string, unknown> }, ...rest: any[]): Promise<FacilioApiResult<T>>;
    fetchRecord<T = any>(moduleName: string, params: { id: string | number; [key: string]: unknown }, ...rest: any[]): Promise<FacilioApiResult<T>>;
    fetchAll<T = any>(moduleName: string, params?: Record<string, unknown>, ...rest: any[]): Promise<FacilioApiListResult<T>>;
    /** `params.id` routes to the record; the fields to patch go under `params.data`. */
    updateRecord<T = any>(moduleName: string, params: { id: string | number; data: Record<string, unknown> }, ...rest: any[]): Promise<FacilioApiResult<T>>;
    deleteRecord<T = any>(moduleName: string, id: string | number | (string | number)[], ...rest: any[]): Promise<FacilioApiResult<T>>;
    deleteRecords<T = any>(moduleName: string, ids: (string | number)[], ...rest: any[]): Promise<FacilioApiResult<T>>;
    uploadFiles(files: File[], onProgress?: (evt: unknown) => void): Promise<{ error: Error | null; ids?: (string | number)[]; data?: unknown }>;
    isNewV3(): boolean;
    fetchAllRelatedList<T = any>(opts: { moduleName: string; id: string | number; relatedModuleName: string; relatedFieldName: string }, params?: Record<string, unknown>, ...rest: any[]): Promise<FacilioApiListResult<T>>;
    fetchSse(url: string, body: unknown, signal?: AbortSignal): Promise<Response>;
    cancel(url: string, params?: Record<string, unknown>): void;
    invalidate(url: string, params?: Record<string, unknown>, name?: string): void;
  };
  export const cache: {
    clear(): void;
    findQuery(url: string, params?: Record<string, unknown>): unknown;
  };
}
