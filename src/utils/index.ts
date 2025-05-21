import { ILogger } from '../types';
import { createHttpUtils } from './http';

export function createUtils(logger: ILogger) {
  return { ...createHttpUtils(logger) };
}