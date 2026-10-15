import React from "react";
import {Composition} from "remotion";
import {Reel} from "./Reel";
import data from "../public/data.json";

export const Root: React.FC = () => (
  <Composition id="Reel" component={Reel} durationInFrames={Math.round(data.total * 30)} fps={30} width={1080} height={1920} />
);
