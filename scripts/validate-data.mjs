import {fileURLToPath} from 'node:url';
import {checkProjectData} from './project-files.mjs';
const {manifest,data}=await checkProjectData(fileURLToPath(new URL('../data/',import.meta.url)));
console.log(`Project data valid: ${manifest.assets.length} assets, ${data.valuations.length} valuation revisions, ${data.prices.length} prices, ${Object.keys(data.fxRates).length} FX pairs.`);
