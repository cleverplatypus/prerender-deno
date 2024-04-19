import { Context, Next, Request } from 'oak';
import { CRAWLER_USER_AGENTS, EXTENSIONS_TO_IGNORE } from './constants.ts';

type PrerenderOptions = {
  [key: string]: boolean | number | string | { [key: string]: string };
};

type AfterRenderOptions = { cancelRender: boolean };
type CacheWriteFunction = (
  request: Request,
  error: string | null,
  body: string | null
) => Promise<void | AfterRenderOptions>;
type CacheReadFunction = (
  request: Request
) => Promise<{ body: string; error?: string }>;

type PrerenderContent = {
  statusCode: string;
  headers: Headers;
  body: string;
  error: string;
};

class Prerenderer {
  private _resolveCache?: CacheReadFunction;
  private _writeCache?: CacheWriteFunction;
  private _whitelist?: string[];
  private _blacklist?: string[];

  public forwardHeaders = false;
  public prerenderToken = '';

  public prerenderServiceUrl = 'http://service.prerender.io/';

  readonly prerenderServerRequestOptions: PrerenderOptions = {};
  set resolveCache(fn: CacheReadFunction) {
    this._resolveCache = fn;
  }

  set writeCache(fn: CacheWriteFunction) {
    this._writeCache = fn;
  }

  set whiteListed(whitelist: string[] | string) {
    this._whitelist = Array.isArray(whitelist) ? whitelist : [whitelist];
  }

  set blackListed(blacklist: string[] | string) {
    this._blacklist = Array.isArray(blacklist) ? blacklist : [blacklist];
  }

  private buildApiUrl(req: Request) {
    //TODO: original had this.host and this.protocol for override
    const prerenderUrl = this.prerenderServiceUrl;
    const forwardSlash =
      prerenderUrl.indexOf('/', prerenderUrl.length - 1) !== -1 ? '' : '/';

    const protocol = 'https';
    // if (req.headers.get('cf-visitor')) {
    //   const match = (req.headers.get('cf-visitor') as string).match(
    //     /"scheme":"(http|https)"/
    //   );
    //   if (match) protocol = match[1];
    // }
    // if (req.headers.get('x-forwarded-proto')) {
    //   protocol = (req.headers.get('x-forwarded-proto') as string).split(',')[0];
    // }
    const hostPort = (req.headers.get('x-forwarded-host') || req.headers.get('host'));
    const url = new URL(`${protocol}://${hostPort}`);
    url.pathname = req.url.pathname;
    url.search = req.url.search;

    const fullUrl = url.toString();
         
    return prerenderUrl + forwardSlash + fullUrl.toString();
  }

  async prerender(context: Context, next: Next) {
    if (!this.shouldShowPrerenderedPage(context.request)) {
      return await next();
    }

    if (this._resolveCache) {
      console.info('trying to resolve cache');

      const { error, body } = await this._resolveCache(context.request);
      if (!error && !!body) {
        return body;
      }
    }

    const { error, body } = await this.getPrerenderedPageResponse(context);

    const cacheOptions = (await this._writeCache?.(
      context.request,
      error,
      body
    )) ?? { cancelRender: false };

    if (cacheOptions.cancelRender) {
      return await next();
    }

    if (error) {
      throw new Error(error);
    }
    return body;
  }

  private shouldShowPrerenderedPage(request: Request) {
    const userAgent = request.headers.get('user-agent'),
      bufferAgent = request.headers.get('x-bufferbot');

    let isRequestingPrerenderedPage = false;

    if (!userAgent) return false;
    if (request.method != 'GET' && request.method != 'HEAD') return false;
    if (request.headers && request.headers.get('x-prerender')) return false;

    const parsedUrl = request.url;
    //if it contains _escaped_fragment_, show prerendered page
    const parsedQuery = parsedUrl.searchParams;
    if (parsedQuery && !!parsedQuery.get('_escaped_fragment_')) {
      isRequestingPrerenderedPage = true;
    }

    //if it is a bot...show prerendered page
    if (
      CRAWLER_USER_AGENTS.some((crawlerUserAgent: string) => {
        return (
          userAgent.toLowerCase().indexOf(crawlerUserAgent.toLowerCase()) !== -1
        );
      })
    ) {
      isRequestingPrerenderedPage = true;
    }

    //if it is BufferBot...show prerendered page
    if (bufferAgent) isRequestingPrerenderedPage = true;

    //if it is a bot and is requesting a resource...dont prerender
    const parsedPathname = parsedUrl.pathname!.toLowerCase();
    if (
      EXTENSIONS_TO_IGNORE.some((extension: string) => {
        return parsedPathname.endsWith(extension);
      })
    ) {
      return false;
    }

    //if it is a bot and not requesting a resource and is not whitelisted...dont prerender
    if (
      Array.isArray(this._whitelist) &&
      this._whitelist.every(function (whitelisted) {
        return new RegExp(whitelisted).test(request.url.href) === false;
      })
    ) {
      return false;
    }

    //if it is a bot and not requesting a resource and is not blacklisted(url or referer)...dont prerender
    if (
      Array.isArray(this._blacklist) &&
      this._blacklist.some(function (blacklisted) {
        let blacklistedUrl = false,
          blacklistedReferer = false;

        const regex = new RegExp(blacklisted);

        blacklistedUrl = regex.test(request.url.href) === true;
        if (request.headers.get('referer')) {
          blacklistedReferer =
            regex.test(request.headers.get('referer') as string) === true;
        }

        return blacklistedUrl || blacklistedReferer;
      })
    ) {
      return false;
    }

    return isRequestingPrerenderedPage;
  }

  private async getPrerenderedPageResponse(
    context: Context
  ): Promise<{ error: string | null; body: string | null }> {
    console.info('invoking prerender server');
    try {
      const req = context.request;
      const options: PrerenderOptions = { headers: {} };
      const headers = options.headers as { [key: string]: string };

      Object.assign(
        options,
        JSON.parse(JSON.stringify(this.prerenderServerRequestOptions))
      );

      if (this.forwardHeaders === true) {
        req.headers.forEach(function (h) {
          // Forwarding the host header can cause issues with server platforms that require it to match the URL
          if (h == 'host') {
            return;
          }
          headers[h] = req.headers.get(h) as string;
        });
      }
      headers['User-Agent'] = req.headers.get('user-agent') as string;
      headers['Accept-Encoding'] = 'gzip';
      if (this.prerenderToken) {
        headers['X-Prerender-Token'] = this.prerenderToken;
      }

      const url = new URL(this.buildApiUrl(req));
      const response = await fetch(
        url,
        Object.assign({}, options, { method: 'GET' })
      );
      const body = await response.text();
      return { error: null, body };
    } catch (error) {
      console.info('Error in prerender server', error.message);

      return { error: error.message, body: null };
    }
  }
}

export default new Prerenderer();
