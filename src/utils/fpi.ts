/* eslint-disable @typescript-eslint/no-explicit-any */

import { FileInPackageIndex, ILogger, PackageResource } from '../types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createFpiUtils(logger: ILogger) {

  /**
     * Generates an index entry for the package resource
     * @param filename resource filename
     * @param content resource content
     * @returns FileInPackageIndex object 
     */
  const extractResourceIndexEntry = (filename: string, content: PackageResource): FileInPackageIndex => {
    const evalAttribute = (att: any | any[]) => (typeof att === 'string' ? att : undefined);
    const indexEntry: FileInPackageIndex = {
      filename,
      resourceType: content.resourceType,
      id: content.id,
      url: evalAttribute(content.url),
      name: evalAttribute(content.name),
      version: evalAttribute(content.version),
      kind: evalAttribute(content.kind),
      type: evalAttribute(content.type),
      supplements: evalAttribute(content.supplements),
      content: evalAttribute(content.content),
      baseDefinition: evalAttribute(content.baseDefinition),
      derivation: evalAttribute(content.derivation),
      date: evalAttribute(content.date)
    };
    return indexEntry;
  };

  return { extractResourceIndexEntry };
}