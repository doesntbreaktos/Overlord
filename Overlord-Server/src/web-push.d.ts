declare module "web-push" {
  interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }
  interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  interface RequestOptions {
    TTL?: number;
  }
  interface RequestDetails {
    endpoint: string;
    method: string;
    headers: Record<string, string | number>;
    body: Buffer | null;
  }
  function generateVAPIDKeys(): VapidKeys;
  function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  function generateRequestDetails(
    subscription: PushSubscription,
    payload: string | Buffer | null,
    options?: RequestOptions,
  ): RequestDetails;
  function sendNotification(subscription: PushSubscription, payload: string | Buffer | null, options?: RequestOptions): Promise<any>;
  export { generateRequestDetails, generateVAPIDKeys, setVapidDetails, sendNotification };
}
