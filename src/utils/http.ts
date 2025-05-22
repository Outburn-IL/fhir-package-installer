/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs-extra';
import https from 'https';
import { ILogger } from '../types';
import { Readable } from 'stream';
import { finished } from 'stream/promises';

export function createHttpUtils(logger: ILogger) {
  
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

  async function fetchJson(url: string): Promise<any> {
    return withRetries(() => new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
          }
        });
      }).on('error', reject);
    }));
  }

  async function fetchStream(url: string): Promise<Readable> {
    return withRetries(() => new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode === 200) {
          resolve(res);
        } else {
          reject(new Error(`Failed to fetch ${url} (status ${res.statusCode})`));
        }
      }).on('error', reject);
    }));
  }

  async function downloadFile(url: string, destination: string): Promise<void> {
    const tarballStream = await fetchStream(url);
    const fileStream = fs.createWriteStream(destination);
    await finished(tarballStream.pipe(fileStream));
  }

  return { 
    withRetries,
    fetchJson,
    fetchStream,
    downloadFile
  };
}