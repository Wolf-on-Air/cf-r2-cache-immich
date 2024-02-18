import parseRange from "range-parser";

export interface Env {
  ALLOWED_ORIGINS: string | null;
  CACHE_BUCKET: R2Bucket;
  CACHE_CONTROL: string | null;
  PARAMS_KEY: string;
  IMAGE_REGEX: string;
  IMAGE_REGEX_POST: string;
  IMAGE_HOST: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e: any) {
      return new Response(e.message, { status: 500 });
    }
  },
};

type ParsedRange = { offset: number, length: number } | { suffix: number };

function rangeHasLength(object: ParsedRange): object is { offset: number, length: number } {
  return (<{ offset: number, length: number }>object).length !== undefined;
}

function hasBody(object: R2Object | R2ObjectBody | null | undefined): object is R2ObjectBody {
  return object !== undefined && object !== null && (<R2ObjectBody>object).body !== undefined;
}

function hasSuffix(range: ParsedRange): range is { suffix: number } {
  return (<{ suffix: number }>range).suffix !== undefined;
}

function getRangeHeader(range: ParsedRange, fileSize: number): string {
  return `bytes ${hasSuffix(range) ? (fileSize - range.suffix) : range.offset}-${hasSuffix(range) ? fileSize - 1 :
    (range.offset + range.length - 1)}/${fileSize}`;
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const cacheKeyRegex = new RegExp(env.IMAGE_REGEX);
  const cacheKeyRegexPOST = new RegExp(env.IMAGE_REGEX_POST);
  let url = new URL(request.url);
  url.host = env.IMAGE_HOST;
  const [match] = ((request.method === "POST") ? cacheKeyRegexPOST : cacheKeyRegex)
    .exec(decodeURIComponent(url.pathname).substring(1)) ?? [];

  if (!(["GET", "HEAD", "POST"].includes(request.method) && match))
    return await fetch(request);

  // Since we produce this result from the request, we don't need to strictly use an R2Range
  let range: ParsedRange | undefined;

  // Try to get it from R2
  let file: R2Object | R2ObjectBody | null | undefined;
  let response: Response;

  // Etag/If-(Not)-Match handling
  // R2 requires that etag checks must not contain quotes, and the S3 spec only allows one etag
  // This silently ignores invalid or weak (W/) headers
  const getHeaderEtag     = (header: string | null) => header?.trim().replace(/^['"]|['"]$/g, "");
  const ifMatch           = getHeaderEtag(request.headers.get("if-match"));
  const ifNoneMatch       = getHeaderEtag(request.headers.get("if-none-match"));
  const ifModifiedSince   = Date.parse(request.headers.get("if-modified-since") || "");
  const ifUnmodifiedSince = Date.parse(request.headers.get("if-unmodified-since") || "");
  const ifRange           = request.headers.get("if-range");

  let params = new URLSearchParams();
  env.PARAMS_KEY.split(",").map((v) => v.trim()).forEach((v) => (url.searchParams.has(v) ? params.append(v, <string>url.searchParams.get(v)) : null));

  let cacheKey = match + ((params.size > 0) ? "+" + encodeURIComponent(params.toString()) : "");

  if (request.method === "GET") {
    const rangeHeader = request.headers.get("range");
    if (rangeHeader && (file = await env.CACHE_BUCKET.head(cacheKey))) {
      const parsedRanges = parseRange(file.size, rangeHeader);

      // R2 only supports 1 range at the moment, reject if there is more than one
      if (parsedRanges !== -1 && parsedRanges !== -2 && parsedRanges.length === 1 && parsedRanges.type === "bytes") {
        let firstRange = parsedRanges[0];
        if (file?.size === (firstRange.end + 1)) {
          range = { suffix: file.size - firstRange.start }
        } else {
          range = { offset: firstRange.start, length: firstRange.end - firstRange.start + 1 }
        }
      } else
        return new Response("Range Not Satisfiable", { status: 416 });
    }
  }


  if (file && range && ifRange) {
    const maybeDate = Date.parse(ifRange);

    if (isNaN(maybeDate) || new Date(maybeDate) > file.uploaded) {
      // httpEtag already has quotes, no need to use getHeaderEtag
      if (ifRange.startsWith("W/") || ifRange !== file.httpEtag)
        range = undefined;
    }
  }

  if (ifMatch || ifUnmodifiedSince) {
    file = await env.CACHE_BUCKET.get(cacheKey, {
      onlyIf: {
        etagMatches: ifMatch,
        uploadedBefore: ifUnmodifiedSince ? new Date(ifUnmodifiedSince) : undefined
      }, range
    });

    if (!hasBody(file))
      return new Response("Precondition Failed", { status: 412 });
  }

  if (ifNoneMatch || ifModifiedSince) {
    // if-none-match overrides if-modified-since completely
    if (ifNoneMatch)
      file = await env.CACHE_BUCKET.get(cacheKey, { onlyIf: { etagDoesNotMatch: ifNoneMatch }, range });
    else if (ifModifiedSince)
      file = await env.CACHE_BUCKET.get(cacheKey, { onlyIf: { uploadedAfter: new Date(ifModifiedSince) }, range });
    if (!hasBody(file))
      return new Response(null, { status: 304 });
  }

  file ??= await env.CACHE_BUCKET.head(cacheKey);

  let originstatus = 0;
  if ((file && (!file.httpMetadata?.cacheControl?.includes("private") ||
    (originstatus = (await fetch(new Request(request, { method: "HEAD", redirect: "manual" }))).status) < 300 || originstatus == 304))) {

    if (!hasBody(file))
      file = await env.CACHE_BUCKET.get(cacheKey, { range }) ?? file;

    response = new Response((hasBody(file) && file.size !== 0) ? file.body : null, {
      status: range ? 206 : 200,
      headers: {
        "accept-ranges": "bytes",
        "access-control-allow-origin": env.ALLOWED_ORIGINS || "",

        "etag": file.httpEtag,
        "cache-control": file.httpMetadata?.cacheControl ?? (env.CACHE_CONTROL || ""),
        "expires": file.httpMetadata?.cacheExpiry?.toUTCString() ?? "",
        "last-modified": file.uploaded.toUTCString(),

        "content-encoding": file.httpMetadata?.contentEncoding ?? "",
        "content-type": file.httpMetadata?.contentType ?? "application/octet-stream",
        "content-language": file.httpMetadata?.contentLanguage ?? "",
        "content-disposition": file.httpMetadata?.contentDisposition ?? "",
        "content-range": range ? getRangeHeader(range, file.size) : "",
        "content-length": (range ? (rangeHasLength(range) ? range.length : range.suffix) : file.size).toString()
      }
    });
  } else if (file === null && !range) {
    console.log(`R2 cache miss for: ${cacheKey}`);
    let headers = new Headers(request.headers);
    headers.delete("if-match");
    headers.delete("if-none-match");
    headers.delete("range");

    try {
      response = await fetch(new Request(request, { headers: headers }));
    } catch (e) {
      return new Response(null, { status: 521 });
    }

    // If we got it, add it to R2 after we finish
    if (["GET", "POST"].includes(request.method) && response.ok && response.body)
      ctx.waitUntil(env.CACHE_BUCKET.put(cacheKey, response.clone().body, { httpMetadata: response.headers }));

  } else return new Response("Bad Request", { status: 400 });

  return response;
}