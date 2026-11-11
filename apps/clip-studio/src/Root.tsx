import { Composition } from 'remotion';
import { FPS, HowTo, calculateHowTo, type HowToProps } from './HowTo';

export function Root() {
  return (
    <Composition
      id="HowTo"
      component={HowTo}
      fps={FPS}
      width={1280}
      height={720}
      durationInFrames={FPS * 10}
      defaultProps={{ id: 'library-drop', captions: true, tape: null } satisfies HowToProps}
      calculateMetadata={calculateHowTo}
    />
  );
}
