import https from 'https';
import { ILogger } from '../types';
import { createErrorUtils } from './error';
import { createFpiUtils } from './fpi';
import { createHttpUtils } from './http';

export function createUtils(logger: ILogger, httpOptions: https.RequestOptions = {}, allowHttp: boolean = false) {
  return { 
    ...createHttpUtils(logger, httpOptions, allowHttp),
    ...createErrorUtils(logger),
    ...createFpiUtils(logger),
  };
}