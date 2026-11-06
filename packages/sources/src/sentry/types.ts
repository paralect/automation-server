export type SentryIssueStats = {
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly permalink: string | null;
};

export type SentryFrame = {
  readonly filename: string | null;
  readonly module: string | null;
  readonly function: string | null;
  readonly lineno: number | null;
  readonly colno: number | null;
  readonly inApp: boolean;
  readonly contextLine: string | null;
};

export type SentryException = {
  readonly type: string | null;
  readonly value: string | null;
  readonly frames: readonly SentryFrame[];
};

export type SentryBreadcrumb = {
  readonly timestamp: string | null;
  readonly type: string | null;
  readonly category: string | null;
  readonly level: string | null;
  readonly message: string | null;
  readonly url: string | null;
  readonly method: string | null;
  readonly statusCode: number | null;
};

export type SentryIssueAlert = {
  readonly issueId: string;
  readonly issueApiUrl: string | null;
  readonly eventId: string | null;
  readonly eventWebUrl: string | null;
  readonly title: string;
  readonly level: string;
  readonly culprit: string | null;
  readonly environment: string | null;
  readonly release: string | null;
  readonly platform: string | null;
  readonly ruleName: string | null;
  readonly occurredAt: string | null;
  readonly exceptions: readonly SentryException[];
  readonly breadcrumbs: readonly SentryBreadcrumb[];
  readonly issue: SentryIssueStats | null;
};
