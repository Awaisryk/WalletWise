import { createClient, RedisClientType } from "redis";

class RedisService {
  private client: RedisClientType;
  private isConnected = false;

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 1000),
      },
    });

    this.client.on("error", (err) => {
      console.error("Redis Client Error:", err);
    });

    this.client.on("connect", () => {
      console.log("Connected to Redis");
      this.isConnected = true;
    });

    this.client.on("disconnect", () => {
      console.log("Disconnected from Redis");
      this.isConnected = false;
    });
  }

  async connect(): Promise<void> {
    if (!this.isConnected) {
      await this.client.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      await this.ensureConnection();
      return await this.client.get(key);
    } catch (error) {
      console.error("Redis GET error:", error);
      return null;
    }
  }

  async set(key: string, value: string, options?: any): Promise<string | null> {
    try {
      await this.ensureConnection();
      return await this.client.set(key, value, options);
    } catch (error) {
      console.error("Redis SET error:", error);
      return null;
    }
  }

  async setEx(key: string, seconds: number, value: string): Promise<void> {
    try {
      await this.ensureConnection();
      await this.client.setEx(key, seconds, value);
    } catch (error) {
      console.error("Redis SETEX error:", error);
    }
  }

  async del(key: string | string[]): Promise<void> {
    try {
      await this.ensureConnection();
      await this.client.del(key);
    } catch (error) {
      console.error("Redis DEL error:", error);
    }
  }

  async incr(key: string): Promise<number> {
    try {
      await this.ensureConnection();
      return await this.client.incr(key);
    } catch (error) {
      console.error("Redis INCR error:", error);
      return 0;
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    try {
      await this.ensureConnection();
      await this.client.expire(key, seconds);
    } catch (error) {
      console.error("Redis EXPIRE error:", error);
    }
  }

  async incrByFloat(key: string, increment: number): Promise<number> {
    try {
      await this.ensureConnection();
      const result = await this.client.incrByFloat(key, increment);
      return typeof result === "string" ? parseFloat(result) : result;
    } catch (error) {
      console.error("Redis INCRBYFLOAT error:", error);
      return 0;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      await this.ensureConnection();
      return await this.client.ttl(key);
    } catch (error) {
      console.error("Redis TTL error:", error);
      return -2;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    try {
      await this.ensureConnection();
      return await this.client.keys(pattern);
    } catch (error) {
      console.error("Redis KEYS error:", error);
      return [];
    }
  }

  private async ensureConnection(): Promise<void> {
    if (!this.isConnected) {
      await this.connect();
    }
  }

  // Health check method
  async ping(): Promise<boolean> {
    try {
      await this.ensureConnection();
      const result = await this.client.ping();
      return result === "PONG";
    } catch (error) {
      console.error("Redis PING error:", error);
      return false;
    }
  }
}

// Export a singleton instance
export const redisClient = new RedisService();

// Graceful shutdown
process.on("SIGTERM", async () => {
  await redisClient.disconnect();
});

process.on("SIGINT", async () => {
  await redisClient.disconnect();
});
