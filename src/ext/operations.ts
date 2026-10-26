/**
 * The API calls `swttch-ext api` can make, as data.
 *
 * One entry is one call: its method, its path, the parameters it takes, and what each answer
 * means. Adding a call is adding an entry; there is deliberately NO way to name a path that is
 * not in this table. The command carries the user's login to a server, and a command that
 * would send it to any path it was given is a general-purpose client for that login. The
 * table is what makes "this tool can rename an artifact" a statement that can be checked, and
 * what the plugin reads (`api --list`) to decide which menu items to offer.
 *
 * The calls here are the ones Claude Code's own artifact client makes (read from the CLI,
 * 2.1.308): same host, same login, same paths. They are not documented by Anthropic.
 */

export type ParamKind = 'string' | 'digits';

export interface ParamSpec {
  name: string;
  kind: ParamKind;
  required: boolean;
  /** What the value is, for `--list` and the help text. */
  about: string;
  /** Longest value accepted, so a runaway argument is refused here and not by the server. */
  maxLength: number;
  /** The path segment this value fills, the body field it becomes, or the query parameter it is. */
  in: 'path' | 'body' | 'query';
  /** For a `digits` value: the largest number accepted. */
  max?: number;
}

/** What a call's answer means, as a code the caller can branch on and a sentence a person can read. */
export interface ErrorRule {
  status: number;
  code: string;
  message: string;
}

export interface Operation {
  service: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `{slug}` marks where a path parameter goes. */
  path: string;
  params: ParamSpec[];
  /** The capability name a caller can look for in `--capabilities`. */
  capability: string;
  /** Changes or removes something that cannot be put back; refuses to run without `--yes`. */
  destructive: boolean;
  /** Answers to a status that say more than the status does. */
  errors: ErrorRule[];
  /** Statuses worth one more try after the server's own Retry-After (capped), as the CLI does for delete. */
  retryOn?: number[];
  about: string;
}

const SLUG: ParamSpec = {
  name: 'slug',
  kind: 'string',
  required: true,
  about: 'The artifact id: the last part of its address, https://claude.ai/artifact/<slug>',
  maxLength: 128,
  in: 'path',
};

const NOT_OWNER_OR_GONE: ErrorRule = {
  status: 404,
  code: 'not_found',
  message: 'Artifact not found. It may have been deleted, or you are not its owner.',
};

export const OPERATIONS: Operation[] = [
  {
    service: 'frame',
    name: 'list',
    method: 'GET',
    path: '/api/frame/frames',
    params: [
      { name: 'limit', kind: 'digits', required: false, about: 'How many to list (default 50, at most 200)', maxLength: 3, in: 'query', max: 200 },
    ],
    capability: 'api.frame.list',
    destructive: false,
    errors: [],
    about: 'List your artifacts: name, owner, when it was updated, whether it is pinned, and what you may do to it',
  },
  {
    service: 'frame',
    name: 'retitle',
    method: 'POST',
    path: '/api/frame/retitle/{slug}',
    params: [
      SLUG,
      { name: 'title', kind: 'string', required: true, about: 'The new name', maxLength: 300, in: 'body' },
    ],
    capability: 'api.frame.retitle',
    destructive: false,
    errors: [
      NOT_OWNER_OR_GONE,
      { status: 409, code: 'conflict', message: 'The name was refused because the artifact changed meanwhile.' },
      { status: 400, code: 'rejected', message: 'The name was refused.' },
      // A page with no <title> has nothing to rename: the server rewrites the title inside the stored page.
      { status: 422, code: 'rejected', message: 'The page could not be renamed. A page needs a <title> in its <head> to be renamed.' },
    ],
    about: 'Rename an artifact you own',
  },
  {
    service: 'frame',
    name: 'pin',
    method: 'POST',
    path: '/api/frame/favorite/{slug}',
    params: [SLUG],
    capability: 'api.frame.pin',
    destructive: false,
    errors: [NOT_OWNER_OR_GONE],
    about: 'Pin an artifact (it stays at the top of the list)',
  },
  {
    service: 'frame',
    name: 'unpin',
    method: 'DELETE',
    path: '/api/frame/favorite/{slug}',
    params: [SLUG],
    capability: 'api.frame.unpin',
    destructive: false,
    errors: [NOT_OWNER_OR_GONE],
    about: 'Unpin an artifact',
  },
  {
    service: 'frame',
    name: 'duplicate',
    method: 'POST',
    path: '/api/frame/duplicate/{slug}',
    params: [SLUG],
    capability: 'api.frame.duplicate',
    destructive: false,
    errors: [
      { status: 404, code: 'not_found', message: 'Artifact not found, or it cannot be copied.' },
      { status: 403, code: 'refused', message: 'This artifact cannot be copied by you.' },
      { status: 409, code: 'refused', message: 'The copy was refused.' },
      { status: 429, code: 'rate_limited', message: 'Too many copies today. Try again later.' },
    ],
    about: 'Make a copy of an artifact; the answer carries the copy\'s id',
  },
  {
    service: 'frame',
    name: 'delete',
    method: 'DELETE',
    path: '/api/frame/{slug}',
    params: [SLUG],
    capability: 'api.frame.delete',
    destructive: true,
    errors: [NOT_OWNER_OR_GONE],
    retryOn: [409, 429, 503],
    about: 'Delete an artifact for good: its link stops working for everyone and it cannot be restored',
  },
];

export function findOperation(service: string, name: string): Operation | undefined {
  return OPERATIONS.find((op) => op.service === service && op.name === name);
}

/** Every capability name the table provides, for `--capabilities`. */
export function operationCapabilities(): string[] {
  return OPERATIONS.map((op) => op.capability);
}
