export class CcbError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'CcbError';
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint && { hint: this.hint }),
      },
    };
  }
}
