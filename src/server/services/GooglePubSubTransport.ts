import { PubSub } from "@google-cloud/pubsub";
import type { Message, Subscription, SubscriptionOptions } from "@google-cloud/pubsub";
import type { PubSubDelivery, StreamingPullTransport } from "./PubSubListenerService";

export interface GooglePubSubClient {
  readonly subscription: (name: string, options?: SubscriptionOptions) => Subscription;
  readonly close: () => Promise<void>;
}

/** Adapts the Google Cloud Pub/Sub subscriber stream to the listener's async-iterable contract. */
export class GooglePubSubTransport implements StreamingPullTransport {
  private readonly activeSubscriptions = new Set<Subscription>();
  private closePromise: Promise<void> | undefined;

  constructor(
    projectId: string,
    private readonly client: GooglePubSubClient = new PubSub({ projectId }),
  ) {}

  async *streamingPull(subscriptionName: string): AsyncIterable<PubSubDelivery> {
    if (this.closePromise) throw new Error("Google Pub/Sub transport is already closed.");
    const subscription = this.client.subscription(subscriptionName, {
      flowControl: { maxMessages: 10 },
    });
    this.activeSubscriptions.add(subscription);

    const messages: Message[] = [];
    let ended = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      const resume = wake;
      wake = undefined;
      resume?.();
    };
    const onMessage = (message: Message) => {
      messages.push(message);
      notify();
    };
    const onError = (error: Error) => {
      failure = error;
      ended = true;
      notify();
    };
    const onClose = () => {
      ended = true;
      notify();
    };

    subscription.on("message", onMessage);
    subscription.on("error", onError);
    subscription.on("close", onClose);

    try {
      while (!ended || messages.length > 0) {
        if (failure) throw failure;
        const message = messages.shift();
        if (message) {
          yield {
            messageId: message.id,
            // PubSub Message.data is already the decoded payload; the listener contract carries base64.
            data: message.data.toString("base64"),
            ack: async () => { message.ack(); },
          };
          continue;
        }
        if (!ended) await new Promise<void>((resolve) => { wake = resolve; });
      }
      if (failure) throw failure;
    } finally {
      subscription.removeListener("message", onMessage);
      subscription.removeListener("error", onError);
      subscription.removeListener("close", onClose);
      this.activeSubscriptions.delete(subscription);
      await subscription.close();
    }
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        try {
          await Promise.all([...this.activeSubscriptions].map((subscription) => subscription.close()));
        } finally {
          await this.client.close();
        }
      })();
    }
    return this.closePromise;
  }
}
