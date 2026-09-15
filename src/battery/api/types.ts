export interface UsageBucket {
  utilization: number;
  resets_at: string | null;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
  locked_reason?: string | null;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency?: string | null;
  decimal_places?: number | null;
  disabled_reason?: string | null;
  user_disabled?: boolean;
  spend_limit_reached?: boolean;
}

/**
 * A limit the API describes by name rather than by giving it a top-level key.
 *
 * Newer per-model windows arrive only in the `limits` array, so a reader that
 * walks the top-level keys never sees them. That is why a Fable weekly limit is
 * absent from the usage display while the API is plainly reporting it: the array
 * is not a duplicate of the flat fields, it is where the entries the flat fields
 * have no name for live.
 */
export interface UsageLimit {
  kind: string;
  percent: number;
  resets_at?: string | null;
  scope?: {
    model?: {
      display_name?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * The usage payload, as far as it is worth naming.
 *
 * The index signature is deliberate. Anthropic ships new windows under
 * codenames (`nimbus_quill`, `juniper_tide`, `tangelo`) without warning, and a
 * closed type would mean cutting a release of this package every time one
 * appears. More importantly, a closed type reads as a promise that these are all
 * the fields there are, and a reader that believed that promise is exactly how
 * the `limits` array came to be overlooked. The runtime payload was never
 * trimmed; only the type claimed it was complete.
 */
export interface UsageResponse {
  five_hour: UsageBucket | null;
  seven_day: UsageBucket | null;
  seven_day_oauth_apps: UsageBucket | null;
  seven_day_opus: UsageBucket | null;
  seven_day_sonnet: UsageBucket | null;
  seven_day_cowork: UsageBucket | null;
  iguana_necktie: unknown | null;
  extra_usage: ExtraUsage | null;
  limits?: UsageLimit[] | null;
  [key: string]: unknown;
}

export interface AccountInfo {
  uuid: string;
  full_name: string;
  display_name: string;
  email: string;
  has_claude_max: boolean;
  has_claude_pro: boolean;
  created_at: string;
}

export interface OrganizationInfo {
  uuid: string;
  name: string;
  organization_type: string;
  billing_type: string;
  rate_limit_tier: string;
  has_extra_usage_enabled: boolean;
  subscription_status: string;
  subscription_created_at: string;
}

export interface ApplicationInfo {
  uuid: string;
  name: string;
  slug: string;
}

export interface ProfileResponse {
  account: AccountInfo;
  organization: OrganizationInfo;
  application: ApplicationInfo;
}
