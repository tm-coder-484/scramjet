use std::error::Error;

use oxc::allocator::StringBuilder;

pub trait UrlRewriter {
	fn rewrite(
		&self,
		cfg: &Config,
		flags: &Flags,
		url: &str,
		builder: &mut StringBuilder,
		module: bool,
	) -> Result<(), Box<dyn Error + Sync + Send>>;
}

pub struct Config {
	pub prefix: String,

	pub wrapfn: String,
	pub wrappropertybase: String,
	pub wrappropertyfn: String,
	pub cleanrestfn: String,
	pub importfn: String,
	pub rewritefn: String,
	pub wrappostmessagefn: String,
	pub metafn: String,
	pub pushsourcemapfn: String,

	pub trysetfn: String,
	pub templocid: String,
	pub tempunusedid: String,
}

#[derive(Debug)]
pub struct Flags {
	pub base: String,
	// the origin static imports are fetched for (the realm's, which is the document's): it tags
	// their urls the way dynamic import() and <script type=module> are tagged, so a module gets one
	// url however it's imported. empty: the base url's origin
	pub origin: String,
	pub sourcetag: String,

	pub is_module: bool,
	pub capture_errors: bool,
	pub scramitize: bool,
	pub do_sourcemaps: bool,
	pub disable_computed_wrap: bool,
	pub destructure_rewrites: bool,
}
