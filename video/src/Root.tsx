import React from 'react';
import { Composition } from 'remotion';
import { Jelajah, totalFrames, FPS } from './Video';

export const Root = () => (
  <>
    <Composition id="Jelajah" component={Jelajah} durationInFrames={totalFrames()} fps={FPS} width={1920} height={1080} />
  </>
);
