export class BadRequest extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

export class NotFound extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
  }
}

/**
 * The caller is writing over a version it has not seen.
 *
 * Carries the current state, because the only useful thing a client can do
 * with a conflict is show the operator what it is now — and asking it to make
 * a second request to find out leaves a window for a third writer.
 */
export class Conflict<T = unknown> extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly current?: T,
  ) {
    super(message);
    this.name = "Conflict";
  }
}
