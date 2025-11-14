module.exports = {
  async init() {
    const debug = require('@tryghost/debug')('mediaInliner');
    const MediaInliner = require('./ExternalMediaInliner');
    const models = require('../../models');
    const jobsService = require('../jobs');

    const mediaStorage = require('../../adapters/storage').getStorage('media');
    const imageStorage = require('../../adapters/storage').getStorage('images');
    const fileStorage = require('../../adapters/storage').getStorage('files');

    const config = require('../../../shared/config');

    const mediaInliner = new MediaInliner({
      PostModel: models.Post,
      TagModel: models.Tag,
      UserModel: models.User,
      PostMetaModel: models.PostsMeta,
      getMediaStorage: (extension) => {
        if (config.get('uploads').images.extensions.includes(extension)) {
          return imageStorage;
        } else if (config.get('uploads').media.extensions.includes(extension)) {
          return mediaStorage;
        } else if (config.get('uploads').files.extensions.includes(extension)) {
          return fileStorage;
        } else {
          return null;
        }
      }
    }, {
      // Configurable rate limiting options
      baseWaitOnRetry: config.get('mediaInliner')?.baseWaitOnRetry || 3000,
      cacheTTL: config.get('mediaInliner')?.cacheTTL || 60 * 60 * 1000, // 60 minutes
      defaultRequestInterval: config.get('mediaInliner')?.defaultRequestInterval || 2000,
      maxConcurrentRequestsPerDomain: config.get('mediaInliner')?.maxConcurrentRequestsPerDomain || 1,
      maxRequestInterval: config.get('mediaInliner')?.maxRequestInterval || 15000,
      maxRetries: config.get('mediaInliner')?.maxRetries || 3,
      minExpectedResponseTime: config.get('mediaInliner')?.minExpectedResponseTime || 2000,
      minRequestInterval: config.get('mediaInliner')?.minRequestInterval || 2000,
      retryableStatusCodes: config.get('mediaInliner')?.retryableStatusCodes || [429, 408, 502, 503, 504]
    });

    this.api = {

      startMediaInliner: async (domains) => {
        if (!domains || !domains.length) {
          // default domains to inline from if none are provided
          domains = [
            'https://s3.amazonaws.com/revue',
            'https://substackcdn.com'
          ];
        }

        debug('[Inliner] Starting media inlining job for domains: ', domains);

        // @NOTE: the job is "inline" (aka non-offloaded into a thread), because usecases are currently
        //        limited to migrational, so there is no expectations for site's availability etc.
        await jobsService.addJob({
          name: 'external-media-inliner',
          job: (data) => {
            return mediaInliner.inline(data.domains);
          },
          data: { domains },
          offloaded: false
        });

        return {
          status: 'success'
        };
      }
    };
  }
};
