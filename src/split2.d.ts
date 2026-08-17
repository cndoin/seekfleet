declare module "split2" {
  import { Transform } from "node:stream";
  interface Split2Matcher {
    (line: string): void;
  }
  interface Split2Mapper {
    (line: string): unknown;
  }
  interface Split2Options {
    maxLength?: number;
    skipOverflow?: boolean;
  }
  function split2(): Transform;
  function split2(matcher: Split2Matcher): Transform;
  function split2(mapper: Split2Mapper): Transform;
  function split2(matcher: Split2Matcher, mapper: Split2Mapper, options?: Split2Options): Transform;
  export default split2;
}
