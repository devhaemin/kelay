declare module 'asl-validator' {
  interface ValidationResult {
    isValid: boolean;
    errors: { message: string; [key: string]: unknown }[];
    errorsText(separator?: string): string;
  }
  export default function aslValidator(
    definition: unknown,
    opts?: { checkPaths?: boolean; checkArn?: boolean },
  ): ValidationResult;
}
