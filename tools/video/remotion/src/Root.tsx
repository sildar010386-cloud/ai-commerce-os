import React from "react";
import {Composition} from "remotion";
import {Reel} from "./Reel";
import {Reel41} from "./Reel41";
import {Mix3D} from "./Mix3D";
import data from "../public/data.json";
import data41 from "../public/data41.json";

export const Root: React.FC = () => (
  <>
    <Composition id="Reel" component={Reel} durationInFrames={Math.round(data.total * 30)} fps={30} width={1080} height={1920} />
    <Composition id="Reel41" component={Reel41} durationInFrames={Math.round(data41.total * 30)} fps={30} width={1080} height={1920} />
    <Composition id="Mix3D" component={Mix3D} durationInFrames={300} fps={30} width={1080} height={1920} />
  </>
);
