const request = require('@tryghost/request');
const logging = require('@tryghost/logging');
const errors = require('@tryghost/errors');
const { URL } = require('url');

class QueueManager {
  constructor(options = {}) {
    // Domain-specific settings and queues
    this.domainStats = new Map(); // Track domain-specific stats
    this.requestQueues = new Map(); // Queue for each domain
    this.activeRequests = new Map(); // Track active requests per domain

    this.baseWaitOnRetry = options.baseWaitOnRetry;
    this.defaultRequestInterval = options.defaultRequestInterval;
    this.maxConcurrentRequestsPerDomain = options.maxConcurrentRequestsPerDomain;
    this.maxRequestInterval = options.maxRequestInterval;
    this.maxRetries = options.maxRetries;
    this.minExpectedResponseTime = options.minExpectedResponseTime;
    this.minRequestInterval = options.minRequestInterval;
    this.retryableStatusCodes = options.retryableStatusCodes;
  }

  /**
   * Get or create domain-specific stats
   * @param {string} domain
   * @returns {Object} domain stats object
   */
  getOrCreateDomainStats(domain) {
    if (!this.domainStats.has(domain)) {
      this.domainStats.set(domain, {
        minRequestInterval: this.defaultRequestInterval, // Current minimum interval between requests
        lastRequestTime: 0, // Timestamp of last request
        requestsInFlight: 0, // Number of active requests
        successCount: 0, // Number of successful requests
        errorCount: 0, // Number of failed requests
        consecutiveErrors: 0 // Consecutive error count
      });
    }
    return this.domainStats.get(domain);
  }

  /**
   * Get or create domain-specific request queue
   * @param {string} domain
   * @returns {Array} request queue
   */
  getOrCreateRequestQueue(domain) {
    if (!this.requestQueues.has(domain)) {
      this.requestQueues.set(domain, []);
    }
    return this.requestQueues.get(domain);
  }

  /**
   * Get or create active request counter for domain
   * @param {string} domain
   * @returns {number} active request count
   */
  getOrCreateActiveRequestCount(domain) {
    if (!this.activeRequests.has(domain)) {
      this.activeRequests.set(domain, 0);
    }
    return this.activeRequests.get(domain);
  }

  /**
   * Process the queue for a specific domain
   */
  async processQueue(domain) {
    const queue = this.getOrCreateRequestQueue(domain);
    const domainStats = this.getOrCreateDomainStats(domain);
    const activeRequests = this.getOrCreateActiveRequestCount(domain);

    // Stop processing if we've hit the concurrent limit
    if (activeRequests >= this.maxConcurrentRequestsPerDomain) {
      return;
    }

    // Check if enough time has passed since last request
    const now = Date.now();
    const timeSinceLastRequest = now - domainStats.lastRequestTime;

    if (timeSinceLastRequest < domainStats.minRequestInterval) {
      const baseDelay = domainStats.minRequestInterval - timeSinceLastRequest;
      const jitter = 1 + (0.15 + (Math.random() * 0.35));
      const totalDelay = baseDelay * jitter;

      setTimeout(() => this.processQueue(domain), totalDelay);
      return;
    }

    // Get next request from queue
    const requestItem = queue.shift();
    if (!requestItem) {
      return; // Queue is empty
    }

    // Update active request count and last request time
    this.activeRequests.set(domain, activeRequests + 1);
    domainStats.lastRequestTime = now;
    domainStats.requestsInFlight++;

    try {
      const startTime = Date.now();
      const result = await this.makeRequestWithRetry(requestItem.url, requestItem.options);
      const responseTime = Date.now() - startTime;
      const jitter = 1 + (0.15 + (Math.random() * 0.55));

      // Update stats for successful request
      domainStats.successCount++;

      // Adapt the rate based on response time
      // If responses are consistently fast, we can increase request frequency
      // If responses are slow, we should slow down to be respectful
      if (responseTime <= this.minExpectedResponseTime) {
        // We can potentially make requests more frequently, but conservatively
        domainStats.minRequestInterval = Math.max(this.minRequestInterval * jitter, domainStats.minRequestInterval * 0.95);
        logging.info(`Fast response from ${domain}, decreasing interval to ${Math.round(domainStats.minRequestInterval)}ms`);
      } else if (responseTime > this.minExpectedResponseTime) {
        // Be more respectful to the server
        domainStats.minRequestInterval = Math.min(this.maxRequestInterval * jitter, domainStats.minRequestInterval * 1.1);
        logging.info(`Slow response from ${domain}, increasing interval to ${Math.round(domainStats.minRequestInterval)}ms`);
      }

      // Decrement consecutiveErrors but only down to zero
      domainStats.consecutiveErrors = Math.max(0, domainStats.consecutiveErrors - 1);
      requestItem.resolve(result);
    } catch (error) {
      // Update stats for failed request
      domainStats.errorCount++;
      domainStats.consecutiveErrors++;

      const statusCode = error.statusCode || (error.response && error.response.status);

      // If we got a retryable status code, increase the request interval significantly
      if (this.retryableStatusCodes.includes(statusCode)) {
        // Immediately set to a high rate limit if we're getting immediate rate limit responses
        if (domainStats.successCount === 0) {
          // If the very first request gets rate limited, be very conservative
          domainStats.minRequestInterval = 10000; // Start with 10 seconds for rate-limited domains
          logging.warn(`First request to ${domain} received status ${statusCode}, setting conservative interval: ${domainStats.minRequestInterval}ms`);
        } else {
          domainStats.minRequestInterval = Math.min(30000, domainStats.minRequestInterval * 3); // Increase by factor of 3 for immediate effect
          logging.warn(`Received status ${statusCode} from ${domain}, increasing interval to ${domainStats.minRequestInterval}ms`);
        }
      }
      // If we have too many consecutive errors, also increase the request interval
      else if (domainStats.consecutiveErrors >= 2) {
        domainStats.minRequestInterval = Math.min(this.maxRequestInterval, domainStats.minRequestInterval * 2); // Max 15 seconds
        logging.info(`Too many consecutive errors for ${domain}, increasing interval to ${domainStats.minRequestInterval}ms`);
      } else if (domainStats.errorCount > 0 && domainStats.successCount === 0) {
        // If we're getting errors early on, be more conservative
        domainStats.minRequestInterval = Math.min(this.maxRequestInterval, domainStats.minRequestInterval * 1.5);
        logging.info(`Early errors for ${domain}, increasing interval to ${domainStats.minRequestInterval}ms`);
      }

      logging.error(`Error downloading remote media: ${requestItem.url}`);
      logging.error(new errors.DataImportError({
        err: error
      }));

      requestItem.reject(error);
    } finally {
      // Update active request count
      const newActiveCount = this.activeRequests.get(domain) - 1;
      this.activeRequests.set(domain, newActiveCount);
      domainStats.requestsInFlight--;

      // Process next request in queue
      setTimeout(() => this.processQueue(domain), Math.random() * 1000);
    }
  }

  /**
   * Make request with retry logic for retryable status codes
   */
  async makeRequestWithRetry(url, options, maxRetries = null, retryCount = 0) {
    // Use instance's maxRetries if not provided, otherwise use provided value
    const effectiveMaxRetries = maxRetries !== null ? maxRetries : this.maxRetries;

    try {
      const response = await request(url, options);
      return response;
    } catch (error) {
      // Check if the error status code is in our retry list
      const statusCode = error.statusCode || (error.response && error.response.status);
      const shouldRetry = this.retryableStatusCodes.includes(statusCode) && retryCount < effectiveMaxRetries;
      ;
      if (shouldRetry) {
        // Calculate wait time: base wait * (retry attempt + 1) * random factor for jitter
        const baseWait = this.baseWaitOnRetry;
        const jitter = 1 + (0.15 + (Math.random() * 0.35));
        const waitTime = Math.floor(baseWait * (retryCount + 1) * jitter);

        logging.info(`Received status ${statusCode} for ${url}, waiting ${waitTime}ms before retry ${retryCount + 1}/${effectiveMaxRetries}`);

        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this.makeRequestWithRetry(url, options, effectiveMaxRetries, retryCount + 1);
      }
      throw error;
    }
  }

  /**
   * Add a request to the queue for a specific domain
   */
  async queueRequest(url, options) {
    return new Promise((resolve, reject) => {
      // Extract domain from URL
      let domain;
      try {
        domain = new URL(url).hostname;
      } catch (e) {
        reject(new Error(`Invalid URL: ${url}`));
        return;
      }

      // Add to domain-specific queue
      const queue = this.getOrCreateRequestQueue(domain);
      queue.push({
        url,
        options,
        resolve: (response) => {
          resolve(response);
        },
        reject
      });

      // Start processing queue if not already active
      setImmediate(() => this.processQueue(domain));
    });
  }

  /**
   * Check if all queues are empty
   */
  areAllQueuesEmpty() {
    for (const queue of this.requestQueues.values()) {
      if (queue.length > 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Wait for all queues to be processed
   */
  async waitForAllQueues() {
    return new Promise((resolve) => {
      const checkQueues = () => {
        if (this.areAllQueuesEmpty() && [...this.activeRequests.values()].every(count => count === 0)) {
          resolve();
        } else {
          setTimeout(checkQueues, 100);
        }
      };
      checkQueues();
    });
  }
}

module.exports = QueueManager;
