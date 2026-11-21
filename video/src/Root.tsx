import React from 'react';
import { Composition } from 'remotion';
import { Jelajah, JelajahVertical, totalFrames, FPS } from './Video';

export const Root = () => (
  <>
    <Composition id="Jelajah" component={Jelajah} durationInFrames={totalFrames()} fps={FPS} width={1920} height={1080} />
    <Composition id="JelajahVertical" component={JelajahVertical} durationInFrames={totalFrames()} fps={FPS} width={1080} height={1920} />
  </>
);
