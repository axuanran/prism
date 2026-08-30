export interface ReferenceOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ReferenceRequest {
  readonly path: string;
  readonly kind?: string;
  readonly query?: string;
}

export type ReferenceLoader = (
  request: ReferenceRequest,
) => Promise<readonly ReferenceOption[]>;
