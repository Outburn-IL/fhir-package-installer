/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs-extra';
import http from 'http';
import https from 'https';
import { AuthenticationError, ILogger } from '../types';
import { Readable } from 'stream';
import { finished } from 'stream/promises';

export function createHttpUtils(logger: ILogger, httpOptions: https.RequestOptions = {}, allowHttp: boolean = false) {
  const MAX_REDIRECTS = 5;

  async function withRetries<T>(
    fn: () => Promise<T>,
    retries = 3,
    delayMs = 5000
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        const isTemporary =
          err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET';
  
        if (!isTemporary || attempt === retries) {
          throw err;
        }
  
        logger.warn(
          `⚠️ Attempt ${attempt} failed (${err.code || err.message}), retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  };

  async function makeHttpRequest<T>(
    url: string,
    responseHandler: (res: http.IncomingMessage, url: string) => Promise<T> | T,
    redirectCount = 0
  ): Promise<T> {
    return withRetries(() => new Promise((resolve, reject) => {
      const isHttps = isHttpsUrl(url);
      const isHttp = isHttpUrl(url);

      // Check if HTTP is allowed for testing
      if (isHttp && !allowHttp) {
        reject(new Error('HTTP URLs not allowed. Use HTTPS or enable allowHttp for testing.'));
        return;
      }

      const client = isHttps ? https : http;
      client.get(url, httpOptions, async (res) => {
        try {
          // Handle redirects (301, 302, 303, 307, 308)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectCount >= MAX_REDIRECTS) {
              reject(new Error(`Too many redirects (${MAX_REDIRECTS}) when fetching ${url}`));
              return;
            }

            const redirectTarget = res.headers.location;
            const displayUrl = redirectTarget.length > 64
              ? `${redirectTarget.substring(0, 64)}...`
              : redirectTarget;
            logger.info(`Following redirect from ${url} to ${displayUrl}`);
            
            // Recursively follow the redirect
            const result = await makeHttpRequest(res.headers.location, responseHandler, redirectCount + 1);
            resolve(result);
            return;
          }

          // Handle authentication/authorization errors consistently
          if (res.statusCode === 403 || res.statusCode === 401) {
            reject(new AuthenticationError('Authentication or authorization failed', res.statusCode));
            return;
          }

          const result = await responseHandler(res, url);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }).on('error', reject);
    }));
  }

  async function fetchJson(url: string, redirectCount = 0): Promise<any> {
    return makeHttpRequest(url, (res, url) => {
      return new Promise((resolve, reject) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          // Check for HTTP error status codes
          if (res.statusCode && res.statusCode >= 400) {
            try {
              const errorData = JSON.parse(data);
              const errorMsg = errorData.error || errorData.message || data;
              reject(new Error(`HTTP ${res.statusCode}: ${errorMsg}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${data || 'Unknown error'}`));
            }
            return;
          }

          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
          }
        });
      });
    }, redirectCount);
  }

  async function fetchStream(url: string, redirectCount = 0): Promise<Readable> {
    return makeHttpRequest(url, (res, url) => {
      if (res.statusCode === 200) {
        return res;
      } else {
        throw new Error(`Failed to fetch ${url} (status ${res.statusCode})`);
      }
    }, redirectCount);
  }

  async function downloadFile(url: string, destination: string): Promise<void> {
    const tarballStream = await fetchStream(url);
    const fileStream = fs.createWriteStream(destination);
    await finished(tarballStream.pipe(fileStream));
  }

  function isHttpsUrl(url: string): boolean {
    return url.startsWith('https:');
  }

  function isHttpUrl(url: string): boolean {
    return url.startsWith('http:');
  }

  return {
    withRetries,
    fetchJson,
    fetchStream,
    downloadFile,
    isHttpsUrl,
    isHttpUrl
  };
}