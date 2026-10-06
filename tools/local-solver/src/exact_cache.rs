use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct Entry {
    version: u32,
    request: String,
    response: Value,
    stored_at: i64,
}

/// The digest only locates a file. Full canonical request equality is always
/// required before a cached solver response can be used.
fn file_name(request: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in request.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("solved-{hash:016x}.json")
}

pub struct ExactCache {
    directory: PathBuf,
    max_entries: usize,
    max_bytes: u64,
    entries: BTreeMap<String, (u64, i64)>,
    persistent: bool,
    hits: u64,
    misses: u64,
    writes: u64,
    errors: u64,
}

impl ExactCache {
    pub fn new(directory: PathBuf, max_entries: usize, max_bytes: u64) -> Self {
        let mut cache = Self {
            directory, max_entries, max_bytes, entries: BTreeMap::new(),
            persistent: false, hits: 0, misses: 0, writes: 0, errors: 0,
        };
        if fs::create_dir_all(&cache.directory).is_err() {
            cache.errors += 1;
            return cache;
        }
        cache.persistent = true;
        if let Ok(entries) = fs::read_dir(&cache.directory) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with("solved-") || !name.ends_with(".json") { continue; }
                if let Ok(meta) = entry.metadata() {
                    if !meta.is_file() { continue; }
                    let modified = meta.modified().ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as i64).unwrap_or(0);
                    cache.entries.insert(name, (meta.len(), modified));
                }
            }
        }
        cache.evict();
        cache
    }

    fn bytes(&self) -> u64 { self.entries.values().map(|(size, _)| *size).sum() }

    fn evict(&mut self) {
        while self.entries.len() > self.max_entries || self.bytes() > self.max_bytes {
            let oldest = self.entries.iter().min_by_key(|(_, (_, time))| *time).map(|(name, _)| name.clone());
            let Some(name) = oldest else { break; };
            if fs::remove_file(self.directory.join(&name)).is_err() { self.errors += 1; }
            self.entries.remove(&name);
        }
    }

    pub fn get(&mut self, request: &str) -> Option<Value> {
        let name = file_name(request);
        let hit = self.entries.get(&name).filter(|(bytes, _)| *bytes <= self.max_bytes)
            .and_then(|_| fs::read(self.directory.join(&name)).ok())
            .and_then(|bytes| serde_json::from_slice::<Entry>(&bytes).ok())
            .filter(|entry| entry.version == 1 && entry.request == request
                && entry.response.pointer("/result/provenance").and_then(Value::as_str) == Some("SOLVED"));
        match hit {
            Some(entry) => {
                self.hits += 1;
                if let Some((_, time)) = self.entries.get_mut(&name) { *time = chrono::Utc::now().timestamp_millis(); }
                Some(entry.response)
            }
            None => { self.misses += 1; None }
        }
    }

    pub fn set(&mut self, request: String, response: Value) {
        if !self.persistent || self.max_entries == 0 { return; }
        if response.pointer("/result/provenance").and_then(Value::as_str) != Some("SOLVED") { return; }
        let name = file_name(&request);
        let time = chrono::Utc::now().timestamp_millis();
        let Ok(bytes) = serde_json::to_vec(&Entry { version: 1, request, response, stored_at: time }) else { self.errors += 1; return; };
        if bytes.len() as u64 > self.max_bytes { return; }
        let temporary = self.directory.join(format!("{name}.pending"));
        let result = fs::write(&temporary, &bytes).and_then(|_| fs::rename(&temporary, self.directory.join(&name)));
        if result.is_err() { self.errors += 1; return; }
        self.entries.insert(name, (bytes.len() as u64, time));
        self.writes += 1;
        self.evict();
    }

    pub fn status(&self) -> Value {
        json!({ "persistent": self.persistent, "entries": self.entries.len(), "bytes": self.bytes(),
            "maxEntries": self.max_entries, "maxBytes": self.max_bytes,
            "hits": self.hits, "misses": self.misses, "writes": self.writes, "errors": self.errors })
    }
}

pub fn default_directory() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("cache").join("exact-v1")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("poker-exact-cache-{name}-{}-{}", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap()))
    }
    fn solved() -> Value { json!({"result":{"provenance":"SOLVED","actions":[
        {"frequency": 0.12733653567244219, "evBB": 12345},
        {"frequency": 0.9085221683564297, "evBB": -900}
    ]}}) }

    #[test]
    fn reload_preserves_only_exact_requests() {
        let path = temp_dir("reload");
        let mut cache = ExactCache::new(path.clone(), 4, 4096);
        cache.set("entire request a".into(), solved());
        drop(cache);
        let mut reloaded = ExactCache::new(path.clone(), 4, 4096);
        assert_eq!(reloaded.get("entire request a"), Some(solved()));
        assert!(reloaded.get("entire request b").is_none());
        assert_eq!(reloaded.status()["entries"], 1);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn rejects_digest_collision_corruption_and_non_solved_output() {
        let path = temp_dir("corrupt");
        let mut cache = ExactCache::new(path.clone(), 4, 4096);
        cache.set("original".into(), solved());
        let file = path.join(file_name("original"));
        let mut parsed: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        parsed["request"] = json!("different request despite same filename");
        fs::write(&file, serde_json::to_vec(&parsed).unwrap()).unwrap();
        assert!(cache.get("original").is_none());
        cache.set("heuristic".into(), json!({"result":{"provenance":"HEURISTIC"}}));
        assert!(cache.get("heuristic").is_none());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn cache_is_bounded_on_write_and_reload() {
        let path = temp_dir("bounded");
        let mut cache = ExactCache::new(path.clone(), 2, 4096);
        for index in 0..5 { cache.set(format!("request-{index}"), solved()); }
        assert_eq!(cache.status()["entries"], 2);
        let reloaded = ExactCache::new(path.clone(), 1, 4096);
        assert_eq!(reloaded.status()["entries"], 1);
        fs::remove_dir_all(path).unwrap();
    }
}
