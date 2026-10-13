export namespace main {
	
	export class CheckArchiveRequest {
	    jobId: string;
	    targetId: string;
	    saveAs: string;
	    note: string;
	    onlyMatched: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CheckArchiveRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.targetId = source["targetId"];
	        this.saveAs = source["saveAs"];
	        this.note = source["note"];
	        this.onlyMatched = source["onlyMatched"];
	    }
	}
	export class CheckRequest {
	    listIds: string[];
	    targets: string[];
	    recursive: boolean;
	    minSize: number;
	    exclude: string[];
	    skipHidden: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CheckRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.listIds = source["listIds"];
	        this.targets = source["targets"];
	        this.recursive = source["recursive"];
	        this.minSize = source["minSize"];
	        this.exclude = source["exclude"];
	        this.skipHidden = source["skipHidden"];
	    }
	}
	export class Config {
	    theme: string;
	    concurrency: number;
	    minSize: number;
	    exclude: string[];
	    skipHidden: boolean;
	    recursive: boolean;
	    incremental: boolean;
	    pageSize: number;
	    lastScanDir: string;
	    lastCheckIn: string[];
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.theme = source["theme"];
	        this.concurrency = source["concurrency"];
	        this.minSize = source["minSize"];
	        this.exclude = source["exclude"];
	        this.skipHidden = source["skipHidden"];
	        this.recursive = source["recursive"];
	        this.incremental = source["incremental"];
	        this.pageSize = source["pageSize"];
	        this.lastScanDir = source["lastScanDir"];
	        this.lastCheckIn = source["lastCheckIn"];
	    }
	}
	export class EnvInfo {
	    dataDir: string;
	    exeDir: string;
	    version: string;
	    os: string;
	    numCPU: number;
	
	    static createFrom(source: any = {}) {
	        return new EnvInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dataDir = source["dataDir"];
	        this.exeDir = source["exeDir"];
	        this.version = source["version"];
	        this.os = source["os"];
	        this.numCPU = source["numCPU"];
	    }
	}
	export class Layer {
	    id: string;
	    name: string;
	    note?: string;
	    source?: string;
	    // Go type: time
	    addedAt: any;
	    count: number;
	    added: number;
	    merged: number;
	
	    static createFrom(source: any = {}) {
	        return new Layer(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.note = source["note"];
	        this.source = source["source"];
	        this.addedAt = this.convertValues(source["addedAt"], null);
	        this.count = source["count"];
	        this.added = source["added"];
	        this.merged = source["merged"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ListMeta {
	    id: string;
	    name: string;
	    note?: string;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	    count: number;
	    totalSize: number;
	    layers?: Layer[];
	    fileName: string;
	
	    static createFrom(source: any = {}) {
	        return new ListMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.note = source["note"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	        this.count = source["count"];
	        this.totalSize = source["totalSize"];
	        this.layers = this.convertValues(source["layers"], Layer);
	        this.fileName = source["fileName"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class MergeRequest {
	    targetId: string;
	    sourceId: string;
	    layerName: string;
	    note: string;
	
	    static createFrom(source: any = {}) {
	        return new MergeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.targetId = source["targetId"];
	        this.sourceId = source["sourceId"];
	        this.layerName = source["layerName"];
	        this.note = source["note"];
	    }
	}
	export class OpResult {
	    ok: boolean;
	    message?: string;
	    count?: number;
	    added?: number;
	    merged?: number;
	    listId?: string;
	
	    static createFrom(source: any = {}) {
	        return new OpResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ok = source["ok"];
	        this.message = source["message"];
	        this.count = source["count"];
	        this.added = source["added"];
	        this.merged = source["merged"];
	        this.listId = source["listId"];
	    }
	}
	export class Page {
	    total: number;
	    offset: number;
	    limit: number;
	    items: any;
	
	    static createFrom(source: any = {}) {
	        return new Page(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total = source["total"];
	        this.offset = source["offset"];
	        this.limit = source["limit"];
	        this.items = source["items"];
	    }
	}
	export class PageQuery {
	    key: string;
	    offset: number;
	    limit: number;
	    query: string;
	    filter: string;
	    layer: string;
	    sort: string;
	    desc: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PageQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.offset = source["offset"];
	        this.limit = source["limit"];
	        this.query = source["query"];
	        this.filter = source["filter"];
	        this.layer = source["layer"];
	        this.sort = source["sort"];
	        this.desc = source["desc"];
	    }
	}
	export class PathKind {
	    path: string;
	    dir: boolean;
	    size: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new PathKind(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.dir = source["dir"];
	        this.size = source["size"];
	        this.error = source["error"];
	    }
	}
	export class ScanOptions {
	    minSize: number;
	    exclude: string[];
	    skipHidden: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ScanOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.minSize = source["minSize"];
	        this.exclude = source["exclude"];
	        this.skipHidden = source["skipHidden"];
	    }
	}
	export class ScanRequest {
	    root: string;
	    roots: string[];
	    options: ScanOptions;
	    incremental: boolean;
	    archive: boolean;
	    saveAs: string;
	    note: string;
	    baseListId: string;
	
	    static createFrom(source: any = {}) {
	        return new ScanRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.roots = source["roots"];
	        this.options = this.convertValues(source["options"], ScanOptions);
	        this.incremental = source["incremental"];
	        this.archive = source["archive"];
	        this.saveAs = source["saveAs"];
	        this.note = source["note"];
	        this.baseListId = source["baseListId"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class StartJobResult {
	    jobId: string;
	    ok: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new StartJobResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	        this.ok = source["ok"];
	        this.error = source["error"];
	    }
	}
	export class TrashLogItem {
	    // Go type: time
	    time: any;
	    path: string;
	    md5?: string;
	    size?: number;
	    source?: string;
	
	    static createFrom(source: any = {}) {
	        return new TrashLogItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.time = this.convertValues(source["time"], null);
	        this.path = source["path"];
	        this.md5 = source["md5"];
	        this.size = source["size"];
	        this.source = source["source"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TrashRequest {
	    paths: string[];
	    jobId: string;
	    dryRun: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TrashRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.paths = source["paths"];
	        this.jobId = source["jobId"];
	        this.dryRun = source["dryRun"];
	    }
	}
	export class TrashResult {
	    moved: number;
	    failed: number;
	    freed: number;
	    errors: string[];
	    dryRun: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TrashResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.moved = source["moved"];
	        this.failed = source["failed"];
	        this.freed = source["freed"];
	        this.errors = source["errors"];
	        this.dryRun = source["dryRun"];
	    }
	}

}

