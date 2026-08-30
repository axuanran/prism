import { PrismError } from "@prismengine/contracts-data";

export function postgresProviderFailure(
  error: unknown,
  code: string,
  message: string,
): PrismError {
  if (error instanceof PrismError) return error;
  return PrismError.of(code, message, { errorType: providerErrorType(error) });
}

function providerErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error";
}
