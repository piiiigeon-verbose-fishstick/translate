class RateLimiter {
  constructor(minIntervalMs = 12000) {
    this.minIntervalMs = minIntervalMs
    this.lastCallTime = 0
    this.queue = Promise.resolve()
  }

  async wait() {
    this.queue = this.queue.then(async () => {
      const now = Date.now()
      const waitTime = Math.max(0, this.minIntervalMs - (now - this.lastCallTime))
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime))
      }
      this.lastCallTime = Date.now()
    })
    return this.queue
  }
}

export const rateLimiter = new RateLimiter(12000)
