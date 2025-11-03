/* eslint-disable @typescript-eslint/no-explicit-any */
import { ILogger } from '../types';

export function createErrorUtils(logger: ILogger) {
  /**
     * Default prethrow function does nothing since the regular throw prints to console.log, which is the default logger
     */
  const defaultPrethrow = (msg: Error | any): Error => {
    if (msg instanceof Error) {
      return msg;
    }
    const error = new Error(msg);
    return error;
  };

  const prethrowWithLogger = (msg: Error | any): Error => {
    if (!(msg instanceof Error)) {
      msg = new Error(msg);
    }
    logger.error(msg.message);
    logger.error(JSON.stringify(msg, null, 2));
    return msg;
  };

  return {
    defaultPrethrow,
    prethrowWithLogger
  };
}