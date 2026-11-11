// What app builders and generated apps import. Screens reach data only through the Data API
// with the user's token, so every call is subject to the app's RLS (contracts §3, §5).
import type { AppRef } from './types.ts';

export type {
  ActionDef,
  AppSchema,
  CallerClaims,
  CollectionDef,
  ErrorCode,
  ErrorResponse,
  FieldDef,
  FieldType,
  GraphNode,
  GraphSpec,
  KelayClaims,
  NodeInvocation,
  Op,
  OpScopes,
  PolicyMatrix,
  QueryRequest,
  QueryResponse,
  Scalar,
  Scope,
  Where,
} from '@kelay/contracts';
export { CALLER_HEADER, HTTP_STATUS, RESERVED_COLUMNS, audienceForApp } from '@kelay/contracts';

export type {
  AnyRow,
  AppRef,
  AppSchemaInput,
  CollectionName,
  CollectionOf,
  Condition,
  DeepReadonly,
  FieldValue,
  GraphSpecInput,
  ImplicitColumns,
  ListQuery,
  NewRow,
  OrderTerm,
  PolicyMatrixInput,
  Row,
  RowPatch,
  SchemaOf,
  WhereFor,
} from './types.ts';
export { defineApp, defineGraph, definePolicy } from './define.ts';
export { KelayError, errorFromResponse, toKelayError, type KelayErrorCode } from './errors.ts';
export type { AuthOptions, TokenGetter } from './http.ts';
export { appSlug, createKelayClient, type CollectionClient, type KelayClient, type KelayClientOptions } from './client.ts';
export { safeMutation, type SafeHandlers, type SafeResult } from './safe.ts';
export { sendFeedback, type SendFeedbackOptions } from './feedback.ts';

/**
 * Register your app once to type the React hooks:
 * `declare module '@kelay/sdk' { interface Register { app: typeof app } }`
 */
export interface Register {}

export type RegisteredApp = Register extends { app: infer A extends AppRef } ? A : string;
