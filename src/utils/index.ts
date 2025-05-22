import { ILogger } from '../types';
import { createErrorUtils } from './error';
import { createFpiUtils } from './fpi';
import { createHttpUtils } from './http';

export function createUtils(logger: ILogger) {
  return { 
    ...createHttpUtils(logger),
    ...createErrorUtils(logger),
    ...createFpiUtils(logger),
  };
}