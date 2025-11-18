const mime = require('mime-types');
const FileType = require('file-type');
const errors = require('@tryghost/errors');
const logging = require('@tryghost/logging');
const string = require('@tryghost/string');
const path = require('path');
const convert = require('heic-convert');
const QueueManager = require('./QueueManager');

class ExternalMediaInliner {
  /** @type {object} */
  #PostModel;

  /** @type {object} */
  #PostMetaModel;

  /** @type {object} */
  #TagModel;

  /** @type {object} */
  #UserModel;

  /** @type {QueueManager} */
  #queueManager;

  /**
   *
   * @param {Object} deps
   * @param {Object} deps.PostModel - Post model
   * @param {Object} deps.PostMetaModel - PostMeta model
   * @param {Object} deps.TagModel - Tag model
   * @param {Object} deps.UserModel - User model
   * @param {(extension) => import('ghost-storage-base')} deps.getMediaStorage - getMediaStorage
   */
  constructor(deps, queueOptions = {}) {
    this.#PostModel = deps.PostModel;
    this.#PostMetaModel = deps.PostMetaModel;
    this.#TagModel = deps.TagModel;
    this.#UserModel = deps.UserModel;
    this.getMediaStorage = deps.getMediaStorage;
    this.#queueManager = new QueueManager(queueOptions);
  }

  /**
   *
   * @param {string} requestURL - url of remote media
   * @returns {Promise<Object>}
   */
  async getRemoteMedia(requestURL) {
    // @NOTE: this is the most expensive operation in the whole inlining process
    //        we should consider caching the results to improve performance

    // Enforce http - http > https redirects are commonplace
    requestURL = requestURL.replace(/^\/\//g, 'http://');

    // Encode to handle special characters in URLs
    requestURL = encodeURI(requestURL);
    try {
      logging.info(`Queueing request for remote media: ${requestURL}`);
      // Use rate-limited request
      const response = await this.#queueManager.queueRequest(requestURL, {
        followRedirect: true,
        responseType: 'buffer'
      });

      logging.info(`Successfully downloaded remote media: ${requestURL}`);
      return response;
    } catch (error) {
      // NOTE: add special case for 404s and temporary errors
      const statusCode = error.statusCode || (error.response && error.response.status);
      if (statusCode && this.#queueManager.retryableStatusCodes.includes(statusCode)) {
        logging.warn(`Temporary error (${statusCode}) when downloading remote media: ${requestURL}`);
      } else {
        logging.error(`Error downloading remote media: ${requestURL}`);
      }
      logging.error(new errors.DataImportError({
        err: error
      }));

      return null;
    }
  }

  /**
   *
   * @param {string} requestURL - url of remote media
   * @param {Object} response - response from request
   * @returns {Promise<Object>}
   */
  async extractFileDataFromResponse(requestURL, response) {
    let extension;
    let body = response.body;

    // Attempt to get the file extension from the file itself
    // If that fails, or if `.ext` is undefined, get the extension from the file path in the catch
    try {
      const fileInfo = await FileType.fromBuffer(body);
      extension = fileInfo.ext;
    } catch {
      const headers = response.headers;
      const contentType = headers['content-type'];
      const extensionFromPath = path.parse(requestURL).ext.split(/[^a-z]/i).filter(Boolean)[0];
      extension = mime.extension(contentType) || extensionFromPath;
    }

    // If the file is heic or heif, attempt to convert it to jpeg
    try {
      if (extension === 'heic' || extension === 'heif') {
        body = await convert({
          buffer: body,
          format: 'JPEG'
        });

        extension = 'jpg';
      }
    } catch (error) {
      logging.error(`Error converting file to JPEG: ${requestURL}`);
      logging.error(new errors.DataImportError({
        err: error
      }));
    }

    const removeExtRegExp = new RegExp(`.${extension}`, '');
    const fileNameNoExt = path.parse(requestURL).base.replace(removeExtRegExp, '');

    // CASE: Query strings _can_ form part of the unique image URL, so rather that strip them include the in the file name
    // Then trim to last 248 chars (this will be more unique than the first 248), and trim leading & trailing dashes.
    // 248 is on the lower end of limits from various OSes and file systems
    const fileName = string.slugify(path.parse(fileNameNoExt).base, {
      requiredChangesOnly: true
    }).slice(-248).replace(/^-|-$/, '');

    return {
      fileBuffer: body,
      filename: `${fileName}.${extension}`,
      extension: `.${extension}`
    };
  }

  /**
   *
   * @param {Object} media - media to store locally
   * @returns {Promise<string>} - path to stored media
   */
  async storeMediaLocally(media) {
    const storage = this.getMediaStorage(media.extension);

    if (!storage) {
      logging.warn(`No storage adapter found for file extension: ${media.extension}`);
      return null;
    } else {
      // @NOTE: this is extremely convoluted and should live on a
      //        storage adapter level
      const targetDir = storage.getTargetDir(storage.storagePath);
      const uniqueFileName = await storage.getUniqueFileName({
        name: media.filename
      }, targetDir);
      const targetPath = path.relative(storage.storagePath, uniqueFileName);
      const filePath = await storage.saveRaw(media.fileBuffer, targetPath);
      return filePath;
    }
  }

  static findMatches(content, domain) {
    // NOTE: the src could end with a quote, bracket, apostrophe, double-backslash, or encoded quote.
    //     Backlashes are added to content as an escape character
    const srcTerminationSymbols = `("|\\)|'|(?=(?:,https?))| |<|\\\\|&quot;|$)`;
    const regex = new RegExp(`(${domain}.*?)(${srcTerminationSymbols})`, 'igm');
    const matches = content.matchAll(regex);

    // Simplify the matches so we only get the result needed
    let matchesArray = Array.from(matches, m => m[1]);

    // Trim trailing commas from each match
    matchesArray = matchesArray.map((item) => {
      return item.replace(/,$/, '');
    });

    return matchesArray;
  }

  /**
   * Find & inline external media from a JSON sting.
   * This works with both Lexical & Mobiledoc, so no separate methods are needed here.
   *
   * @param {string} content - stringified JSON of post Lexical or Mobiledoc content
   * @param {String[]} domains - domains to inline media from
   * @param {Map} [sharedUrlCache] - Optional shared cache to store filePaths for URLs
   * @returns {Promise<string>} - updated stringified JSON of post content
   */
  async inlineContent(content, domains, sharedUrlCache = null) {
    // If no shared cache is provided, use a local one for this function
    const urlCache = sharedUrlCache || new Map();

    for (const domain of domains) {
      const matches = this.constructor.findMatches(content, domain);

      // Get unique matches to avoid processing the same URL multiple times
      const uniqueMatches = [...new Set(matches)];

      for (const src of uniqueMatches) {
        // Normalize the URL the same way as in getRemoteMedia to ensure cache consistency
        const normalizedSrc = encodeURI(src.replace(/^\/\//g, 'http://'));

        // Check if we already have the filePath for this URL in our cache
        if (urlCache.has(normalizedSrc)) {
          const filePath = urlCache.get(normalizedSrc);
          const inlinedSrc = `__GHOST_URL__${filePath}`;

          // Replace all occurrences of the original URL in content
          // Use a global replace with proper escaping
          const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedSrc, 'g');
          content = content.replace(regex, inlinedSrc);

          logging.info(`From cache: Inlined media: ${src} -> ${inlinedSrc}`);
          continue; // Skip to the next URL since we already have the result from cache
        }

        const response = await this.getRemoteMedia(src);

        let media;
        if (response) {
          media = await this.extractFileDataFromResponse(src, response);
        }

        if (media) {
          const filePath = await this.storeMediaLocally(media);

          if (filePath) {
            const inlinedSrc = `__GHOST_URL__${filePath}`;

            // Replace all occurrences of the original URL in content
            // Use a global replace with proper escaping
            const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedSrc, 'g');
            content = content.replace(regex, inlinedSrc);

            logging.info(`Inlined media: ${src} -> ${inlinedSrc}`);

            // Store the filePath in our cache with the normalized URL as key
            urlCache.set(normalizedSrc, filePath);
          }
        }
      }
    }

    return content;
  }

  /**
   *
   * @param {Object} resourceModel - one of PostModel, TagModel, UserModel instances
   * @param {String[]} fields - fields to inline
   * @param {String[]} domains - domains to inline media from
   * @param {Map} [sharedUrlCache] - Optional shared cache to store filePaths for URLs
   * @returns Promise<Object} - updated fields map with local media paths
   */
  async inlineFields(resourceModel, fields, domains, sharedUrlCache = null) {
    // If no shared cache is provided, use a local one for this function
    const urlCache = sharedUrlCache || new Map();
    const updatedFields = {};

    for (const field of fields) {
      for (const domain of domains) {
        const src = resourceModel.get(field);

        if (src && src.startsWith(domain)) {
          // Normalize the URL the same way as in getRemoteMedia to ensure cache consistency
          const normalizedSrc = encodeURI(src.replace(/^\/\//g, 'http://'));

          // Check if we already have the filePath for this URL in our cache
          if (urlCache.has(normalizedSrc)) {
            const filePath = urlCache.get(normalizedSrc);
            const inlinedSrc = `__GHOST_URL__${filePath}`;

            updatedFields[field] = inlinedSrc;
            logging.info(`From cache: Added media to inline: ${src} -> ${inlinedSrc}`);
            continue; // Skip to the next field since we already have the result from cache
          }

          const response = await this.getRemoteMedia(src);

          let media;
          if (response) {
            media = await this.extractFileDataFromResponse(src, response);
          }

          if (media) {
            const filePath = await this.storeMediaLocally(media);

            if (filePath) {
              const inlinedSrc = `__GHOST_URL__${filePath}`;

              updatedFields[field] = inlinedSrc;
              logging.info(`Added media to inline: ${src} -> ${inlinedSrc}`);

              // Store the filePath in our cache with the normalized URL as key
              urlCache.set(normalizedSrc, filePath);
            }
          }
        }
      }
    }

    return updatedFields;
  }

  /**
   *
   * @param {Object[]} resources - array of model instances
   * @param {Object} model - resource model
   * @param {string[]} fields - fields to inline
   * @param {string[]} domains - domains to inline media from
   * @param {Map} [sharedUrlCache] - Optional shared cache to store filePaths for URLs
   */
  async inlineSimpleFields(resources, model, fields, domains, sharedUrlCache = null) {
    logging.info(`Starting inlining external media for ${resources?.length} resources and with ${fields.join(', ')} fields`);

    for (const resource of resources) {
      try {
        const updatedFields = await this.inlineFields(resource, fields, domains, sharedUrlCache);

        if (Object.keys(updatedFields).length > 0) {
          await model.edit(updatedFields, {
            id: resource.id,
            context: {
              internal: true
            }
          });
        }
      } catch (err) {
        logging.error(`Error inlining media for: ${resource.id}`);
        logging.error(new errors.DataImportError({
          err
        }));
      }
    }
  }

  /**
   *
   * @param {string[]} domains domains to inline media from
   */
  async inline(domains) {
    // Create a shared cache for the entire operation to avoid processing the same URL multiple times
    const sharedUrlCache = new Map();

    const posts = await this.#PostModel.findAll({ context: { internal: true } });
    const postsInilingFields = [
      'feature_image'
    ];

    logging.info(`Starting inlining external media for ${posts?.length} posts`);

    for (const post of posts) {
      try {
        const mobiledocContent = post.get('mobiledoc');
        const lexicalContent = post.get('lexical');

        const updatedFields = await this.inlineFields(post, postsInilingFields, domains, sharedUrlCache);

        if (mobiledocContent) {
          const inlinedContent = await this.inlineContent(mobiledocContent, domains, sharedUrlCache);

          // If content has changed, update the post
          if (inlinedContent !== mobiledocContent) {
            updatedFields.mobiledoc = inlinedContent;
          }
        }

        if (lexicalContent) {
          const inlinedContent = await this.inlineContent(lexicalContent, domains, sharedUrlCache);

          // If content has changed, update the post
          if (inlinedContent !== lexicalContent) {
            updatedFields.lexical = inlinedContent;
          }
        }

        if (Object.keys(updatedFields).length > 0) {
          await this.#PostModel.edit(updatedFields, {
            id: post.id,
            context: {
              internal: true
            }
          });
        }
      } catch (err) {
        logging.error(`Error inlining media for post: ${post.id}`);
        logging.error(new errors.DataImportError({
          err
        }));
      }
    }

    const { data: postsMetas } = await this.#PostMetaModel.findPage({
      limit: 'all'
    });
    const postsMetaInilingFields = [
      'og_image',
      'twitter_image'
    ];

    // We need to update inlineSimpleFields to pass the cache as well
    await this.inlineSimpleFields(postsMetas, this.#PostMetaModel, postsMetaInilingFields, domains, sharedUrlCache);

    const { data: tags } = await this.#TagModel.findPage({
      limit: 'all'
    });
    const tagInliningFields = [
      'feature_image',
      'og_image',
      'twitter_image'
    ];

    await this.inlineSimpleFields(tags, this.#TagModel, tagInliningFields, domains, sharedUrlCache);

    const { data: users } = await this.#UserModel.findPage({
      limit: 'all'
    });
    const userInliningFields = [
      'profile_image',
      'cover_image'
    ];

    await this.inlineSimpleFields(users, this.#UserModel, userInliningFields, domains, sharedUrlCache);

    // Wait for all queued requests to complete before finishing
    await this.#queueManager.waitForAllQueues();

    // Clear the shared cache to free up memory
    sharedUrlCache.clear();

    logging.info('Finished inlining external media for posts, tags, and users');
  }
}

module.exports = ExternalMediaInliner;
