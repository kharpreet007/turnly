export interface Queue {
  send(name: JobName, data: object, opts?: { singletonKey?: string }): Promise<void>;
}

export type JobName = 'send_welcome' | 'alert_operator' | 'wa_webhook' | 'capi_lead';
export const JOB_NAMES: JobName[] = ['send_welcome', 'alert_operator', 'wa_webhook', 'capi_lead'];
