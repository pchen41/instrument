import { z } from 'zod';
import { confidenceLevel } from './enums';

// repositories.service_map[] — path-glob to service mappings used to attribute
// code paths to services/environments (folds the old services /
// repository_service_paths tables).
export const serviceMapEntry = z
  .object({
    path_glob: z.string().min(1),
    service_name: z.string().min(1),
    environment: z.string().min(1).default('production'),
    confidence: confidenceLevel.nullish(),
    source: z.string().nullish(),
  })
  .strict();
export type ServiceMapEntry = z.infer<typeof serviceMapEntry>;
