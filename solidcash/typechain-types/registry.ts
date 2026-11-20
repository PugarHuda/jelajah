/* eslint-disable */
import '@solidcash/testing/hre';

declare module '@solidcash/testing/hre' {
  interface SolidcashArtifactMap {
    'StampCard': typeof import('../artifacts/solidcash/contracts/StampCard.scash/StampCard.artifact.js').default;
  }
}

export {};
