import { PubSub } from "@google-cloud/pubsub";
import type { Message, Subscription, SubscriptionOptions } from "@google-cloud/pubsub";
import type { PubSubDelivery, StreamingPullTransport } from "./PubSubListenerService";

export interface GooglePubSubClient {
  readonly subscription: (name: string, options?: SubscriptionOptions) => Subscription;
  readonly close: () => Promise<void>;
}

export interface GooglePubSubOAuthCredentials {
  readonly type: "authorized_user";
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
}

export type GooglePubSubClientFactory = () => GooglePubSubClient | Promise<GooglePubSubClient>;

export interface GooglePubSubTransportOptions {
  /** Called once a StreamingPull subscription is open and listening. */
  readonly onStreamOpened?: () => void;
}

/** Adapts the Google Cloud Pub/Sub subscriber stream to the listener's async-iterable contract. */
export class GooglePubSubTransport implements StreamingPullTransport {
  private readonly activeSubscriptions = new Set<Subscription>();
  private readonly clientFactory: GooglePubSubClientFactory;
  private readonly immediateClient: GooglePubSubClient | undefined;
  private clientPromise: Promise<GooglePubSubClient> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    projectId: string,
    clientOrFactory?: GooglePubSubClient | GooglePubSubClientFactory,
    private readonly options: GooglePubSubTransportOptions = {},
  ) {
    this.immediateClient = clientOrFactory && typeof clientOrFactory !== "function" ? clientOrFactory : undefined;
    this.clientFactory = typeof clientOrFactory === "function"
      ? clientOrFactory
      : this.immediateClient
        ? () => this.immediateClient!
        : () => new PubSub({ projectId });
    if (this.immediateClient) this.clientPromise = Promise.resolve(this.immediateClient);
  }

  private getClient(): Promise<GooglePubSubClient> {
    if (!this.clientPromise) {
      const created = Promise.resolve().then(this.clientFactory);
      this.clientPromise = created;
      // A client that failed to build (e.g. rejected credentials) is not cached: the next stream retries.
      created.catch(() => {
        if (this.clientPromise === created) this.clientPromise = undefined;
      });
    }
    return this.clientPromise;
  }

  /**
   * Drops the current client (e.g. after Pub/Sub was reauthorized) and ends open streams, so the
   * listener reconnects through the factory with fresh credentials.
   */
  async replaceClient(): Promise<void> {
    if (this.immediateClient || this.closePromise) return;
    const previous = this.clientPromise;
    this.clientPromise = undefined;
    await Promise.all([...this.activeSubscriptions].map((subscription) => subscription.close()));
    const client = await previous?.catch(() => undefined);
    await client?.close();
  }

  async *streamingPull(subscriptionName: string): AsyncIterable<PubSubDelivery> {
    if (this.closePromise) throw new Error("Google Pub/Sub transport is already closed.");
    // Keep injected clients synchronous so listeners are attached before the first
    // iterator.next() yields; OAuth-backed production factories can resolve async.
    const client = this.immediateClient ?? await this.getClient();
    const subscription = client.subscription(subscriptionName, {
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
    this.options.onStreamOpened?.();

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
          const client = await this.clientPromise?.catch(() => undefined);
          await client?.close();
        }
      })();
    }
    return this.closePromise;
  }
}
