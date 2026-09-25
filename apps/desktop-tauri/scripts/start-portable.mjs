import {
  launchPortable,
  resolveLatestPortableExecutable,
} from "./portable-launcher.mjs";

const { executable } = await resolveLatestPortableExecutable();
const processId = launchPortable(executable);
console.log(JSON.stringify({ processId, executable }));
