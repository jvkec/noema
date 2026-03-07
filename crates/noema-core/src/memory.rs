//! Memory engine primitives for a life-repo experience.
//!
//! This module provides two core capabilities:
//! 1) Extract structured life signals from plain markdown notes.
//! 2) Compute a salience score to prioritize notes worth resurfacing.
//!
//! The model is intentionally heuristic and fully local-first. It avoids network
//! calls and keeps all scoring deterministic for debuggability.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::notes::Note;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifeArea {
    SelfCare,
    Work,
    Relationships,
    Health,
    Money,
    Home,
    Learning,
}

impl LifeArea {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SelfCare => "self_care",
            Self::Work => "work",
            Self::Relationships => "relationships",
            Self::Health => "health",
            Self::Money => "money",
            Self::Home => "home",
            Self::Learning => "learning",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryWeights {
    pub recency: f32,
    pub repetition: f32,
    pub unresolved: f32,
    pub emotional: f32,
    pub life_area_gap: f32,
}

impl Default for MemoryWeights {
    fn default() -> Self {
        Self {
            recency: 0.28,
            repetition: 0.2,
            unresolved: 0.32,
            emotional: 0.1,
            life_area_gap: 0.1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMemorySignals {
    pub note_path: String,
    pub title: String,
    pub life_areas: Vec<LifeArea>,
    pub people: Vec<String>,
    pub decisions: Vec<String>,
    pub goals: Vec<String>,
    pub open_loops: usize,
    pub emotional_tone: f32,
    pub repetition_index: f32,
    pub recency_days: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryCard {
    pub note_path: String,
    pub title: String,
    pub life_areas: Vec<LifeArea>,
    pub salience: f32,
    pub rationale: Vec<String>,
    pub open_loops: usize,
    pub people: Vec<String>,
    pub decisions: Vec<String>,
    pub goals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryOverview {
    pub generated_at_unix: i64,
    pub area_distribution: BTreeMap<String, usize>,
    pub cards: Vec<MemoryCard>,
}

#[derive(Debug, Clone, Default)]
struct CorpusStats {
    area_counts: HashMap<LifeArea, usize>,
    max_area_count: usize,
}

pub fn build_memory_overview(notes: &[Note], limit: usize) -> MemoryOverview {
    let signals: Vec<NoteMemorySignals> = notes.iter().map(extract_note_signals).collect();
    let stats = corpus_stats(&signals);
    let weights = MemoryWeights::default();

    let mut cards: Vec<MemoryCard> = signals
        .iter()
        .map(|s| memory_card(s, &stats, &weights))
        .collect();

    cards.sort_by(|a, b| b.salience.total_cmp(&a.salience));
    cards.truncate(limit.max(1));

    let mut area_distribution = BTreeMap::new();
    for area in [
        LifeArea::SelfCare,
        LifeArea::Work,
        LifeArea::Relationships,
        LifeArea::Health,
        LifeArea::Money,
        LifeArea::Home,
        LifeArea::Learning,
    ] {
        area_distribution.insert(
            area.as_str().to_string(),
            *stats.area_counts.get(&area).unwrap_or(&0),
        );
    }

    MemoryOverview {
        generated_at_unix: unix_now_secs(),
        area_distribution,
        cards,
    }
}

pub fn extract_note_signals(note: &Note) -> NoteMemorySignals {
    let title = note
        .frontmatter
        .as_ref()
        .and_then(|fm| fm.title.clone())
        .or_else(|| {
            note.body
                .lines()
                .find(|line| !line.trim().is_empty())
                .map(|line| line.trim().to_string())
        })
        .unwrap_or_else(|| note.path.display().to_string());

    let areas = infer_life_areas(note, &title);

    let people = detect_people(&note.body);
    let decisions = detect_sentences(
        &note.body,
        &["decide", "decision", "chose", "commit", "we will", "i will"],
    );
    let goals = detect_sentences(
        &note.body,
        &["goal", "plan", "todo", "next", "intent", "target", "- [ ]"],
    );
    let open_loops = count_open_loops(&note.body);
    let emotional_tone = emotional_tone(&note.body);
    let repetition_index = repetition_index(&note.body);
    let recency_days = note_age_days(note);

    NoteMemorySignals {
        note_path: note.path.display().to_string(),
        title,
        life_areas: areas,
        people,
        decisions,
        goals,
        open_loops,
        emotional_tone,
        repetition_index,
        recency_days,
    }
}

fn memory_card(
    signals: &NoteMemorySignals,
    stats: &CorpusStats,
    weights: &MemoryWeights,
) -> MemoryCard {
    let recency_weight = signals
        .recency_days
        .map(|days| 1.0 / (1.0 + (days / 30.0).max(0.0)))
        .unwrap_or(0.35)
        .clamp(0.0, 1.0);

    let unresolved_weight =
        (signals.open_loops as f32 / 3.0 + signals.goals.len() as f32 / 5.0).clamp(0.0, 1.0);

    let emotional_weight = signals.emotional_tone.abs().clamp(0.0, 1.0);

    let repetition_weight = signals.repetition_index.clamp(0.0, 1.0);

    let gap_weight = if signals.life_areas.is_empty() || stats.max_area_count == 0 {
        0.0
    } else {
        let total: f32 = signals
            .life_areas
            .iter()
            .map(|area| {
                let count = *stats.area_counts.get(area).unwrap_or(&0) as f32;
                1.0 - (count / stats.max_area_count as f32)
            })
            .sum();
        (total / signals.life_areas.len() as f32).clamp(0.0, 1.0)
    };

    let salience = (weights.recency * recency_weight)
        + (weights.repetition * repetition_weight)
        + (weights.unresolved * unresolved_weight)
        + (weights.emotional * emotional_weight)
        + (weights.life_area_gap * gap_weight);

    let mut rationale = Vec::new();
    if signals.open_loops > 0 {
        rationale.push(format!("{} open loop(s)", signals.open_loops));
    }
    if !signals.goals.is_empty() {
        rationale.push(format!(
            "{} explicit goal/plan mention(s)",
            signals.goals.len()
        ));
    }
    if let Some(days) = signals.recency_days {
        rationale.push(format!("updated {:.1} day(s) ago", days));
    }
    if emotional_weight > 0.4 {
        rationale.push("strong emotional language".to_string());
    }
    if gap_weight > 0.6 {
        rationale.push("underrepresented life area".to_string());
    }

    MemoryCard {
        note_path: signals.note_path.clone(),
        title: signals.title.clone(),
        life_areas: signals.life_areas.clone(),
        salience: salience.clamp(0.0, 1.0),
        rationale,
        open_loops: signals.open_loops,
        people: signals.people.clone(),
        decisions: signals.decisions.clone(),
        goals: signals.goals.clone(),
    }
}

fn corpus_stats(signals: &[NoteMemorySignals]) -> CorpusStats {
    let mut area_counts: HashMap<LifeArea, usize> = HashMap::new();
    for s in signals {
        for area in &s.life_areas {
            *area_counts.entry(*area).or_insert(0) += 1;
        }
    }
    let max_area_count = area_counts.values().copied().max().unwrap_or(0);
    CorpusStats {
        area_counts,
        max_area_count,
    }
}

fn infer_life_areas(note: &Note, title: &str) -> Vec<LifeArea> {
    let mut scores: HashMap<LifeArea, usize> = HashMap::new();

    let mut text = format!("{}\n{}", title.to_lowercase(), note.body.to_lowercase());
    if let Some(fm) = note.frontmatter.as_ref() {
        for tag in &fm.tags {
            text.push(' ');
            text.push_str(&tag.to_lowercase());
        }
        if let Some(kind) = fm.kind.as_ref() {
            text.push(' ');
            text.push_str(&kind.to_lowercase());
        }
    }

    score_area_keywords(
        &mut scores,
        &text,
        LifeArea::SelfCare,
        &["journal", "reflect", "mind", "personal", "values"],
    );
    score_area_keywords(
        &mut scores,
        &text,
        LifeArea::Work,
        &["work", "career", "project", "meeting", "client", "ship"],
    );
    score_area_keywords(
        &mut scores,
        &text,
        LifeArea::Relationships,
        &[
            "family",
            "friend",
            "partner",
            "relationship",
            "team",
            "mentor",
        ],
    );
    score_area_keywords(
        &mut scores,
        &text,
        LifeArea::Health,
        &[
            "health",
            "sleep",
            "workout",
            "meal",
            "run",
            "exercise",
            "meditation",
        ],
    );
    score_area_keywords(
        &mut scores,
        &text,
        LifeArea::Money,
        &["money", "finance", "budget", "expense", "salary", "invest"],
    );
    score_area_keywords(
        &mut scores,
        &text,
        LifeArea::Home,
        &["home", "house", "chore", "errand", "admin", "maintenance"],
    );
    score_area_keywords(
        &mut scores,
        &text,
        LifeArea::Learning,
        &["learn", "study", "read", "write", "research", "idea"],
    );

    if scores.is_empty() {
        return vec![LifeArea::Learning];
    }

    let max_score = scores.values().copied().max().unwrap_or(0);
    let mut ranked: Vec<(LifeArea, usize)> = scores.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));

    ranked
        .into_iter()
        .filter(|(_, score)| *score + 1 >= max_score)
        .map(|(area, _)| area)
        .take(2)
        .collect()
}

fn score_area_keywords(
    scores: &mut HashMap<LifeArea, usize>,
    text: &str,
    area: LifeArea,
    keywords: &[&str],
) {
    let mut count = 0usize;
    for kw in keywords {
        count += text.matches(kw).count();
    }
    if count > 0 {
        *scores.entry(area).or_insert(0) += count;
    }
}

fn detect_people(body: &str) -> Vec<String> {
    let mut people = HashSet::new();

    for token in body.split_whitespace() {
        if let Some(name) = token.strip_prefix('@') {
            let cleaned = name
                .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
                .to_lowercase();
            if cleaned.len() >= 2 {
                people.insert(cleaned);
            }
        }
    }

    let markers = ["with ", "met ", "called ", "talked to "];
    let lowered = body.to_lowercase();
    for marker in markers {
        let mut start = 0usize;
        while let Some(idx) = lowered[start..].find(marker) {
            let from = start + idx + marker.len();
            let rest = &body[from..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphabetic() || *c == ' ' || *c == '-')
                .collect();
            let cleaned = name.trim();
            if cleaned.len() >= 3 {
                people.insert(cleaned.to_lowercase());
            }
            start = from;
        }
    }

    let mut v: Vec<String> = people.into_iter().collect();
    v.sort();
    v.truncate(8);
    v
}

fn detect_sentences(body: &str, needles: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for line in body.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let lowered = l.to_lowercase();
        if needles.iter().any(|needle| lowered.contains(needle)) {
            out.push(l.to_string());
        }
    }
    out.truncate(6);
    out
}

fn count_open_loops(body: &str) -> usize {
    body.lines()
        .filter(|line| {
            let l = line.trim_start().to_ascii_lowercase();
            l.starts_with("- [ ]") || l.starts_with("* [ ]") || l.starts_with("todo:")
        })
        .count()
}

fn emotional_tone(body: &str) -> f32 {
    let positives = [
        "grateful",
        "excited",
        "happy",
        "calm",
        "confident",
        "energized",
    ];
    let negatives = [
        "anxious",
        "stressed",
        "sad",
        "angry",
        "tired",
        "overwhelmed",
    ];

    let words = words(body);
    if words.is_empty() {
        return 0.0;
    }

    let mut pos = 0usize;
    let mut neg = 0usize;
    for w in words {
        if positives.contains(&w.as_str()) {
            pos += 1;
        }
        if negatives.contains(&w.as_str()) {
            neg += 1;
        }
    }

    let total = (pos + neg) as f32;
    if total == 0.0 {
        0.0
    } else {
        ((pos as f32 - neg as f32) / total).clamp(-1.0, 1.0)
    }
}

fn repetition_index(body: &str) -> f32 {
    let stop_words: HashSet<&'static str> = [
        "the", "and", "for", "that", "with", "this", "from", "have", "will", "was", "are", "you",
        "your", "about", "into", "note", "todo", "done", "then", "they", "them", "our", "out",
        "but", "not", "just",
    ]
    .into_iter()
    .collect();

    let words: Vec<String> = words(body)
        .into_iter()
        .filter(|w| w.len() >= 4 && !stop_words.contains(w.as_str()))
        .collect();

    if words.is_empty() {
        return 0.0;
    }

    let mut freq: HashMap<String, usize> = HashMap::new();
    for w in words.iter() {
        *freq.entry(w.clone()).or_insert(0) += 1;
    }

    let max_freq = freq.values().copied().max().unwrap_or(1) as f32;
    (max_freq / words.len() as f32).clamp(0.0, 1.0)
}

fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();

    for ch in text.chars() {
        if ch.is_ascii_alphabetic() {
            buf.push(ch.to_ascii_lowercase());
        } else if !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }

    out
}

fn note_age_days(note: &Note) -> Option<f32> {
    if let Some(frontmatter) = note.frontmatter.as_ref() {
        if let Some(d) = frontmatter.date.as_ref() {
            if let Some(days) = parse_date_to_days(d) {
                return Some((unix_now_days() - days) as f32);
            }
        }
    }

    let modified = fs::metadata(&note.path).ok()?.modified().ok()?;
    let age_secs = SystemTime::now()
        .duration_since(modified)
        .ok()?
        .as_secs_f32();
    Some(age_secs / 86_400.0)
}

fn parse_date_to_days(s: &str) -> Option<i64> {
    let date = s.get(0..10)?;
    let mut it = date.split('-');
    let year = it.next()?.parse::<i32>().ok()?;
    let month = it.next()?.parse::<u32>().ok()?;
    let day = it.next()?.parse::<u32>().ok()?;
    Some(days_from_civil(year, month, day))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let month_adj = month as i32;
    let day_adj = day as i32;
    let doy = (153 * (month_adj + if month_adj > 2 { -3 } else { 9 }) + 2) / 5 + day_adj - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era as i64) * 146097 + (doe as i64) - 719468
}

fn unix_now_days() -> i64 {
    unix_now_secs() / 86_400
}

fn unix_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::notes::{Note, NoteFrontmatter};

    fn note(path: &str, title: Option<&str>, date: Option<&str>, body: &str) -> Note {
        Note {
            path: PathBuf::from(path),
            raw: body.to_string(),
            frontmatter: Some(NoteFrontmatter {
                title: title.map(ToString::to_string),
                date: date.map(ToString::to_string),
                tags: Vec::new(),
                kind: None,
                extra: Default::default(),
            }),
            body: body.to_string(),
        }
    }

    #[test]
    fn extracts_open_loops_people_and_goals() {
        let n = note(
            "journal/day.md",
            Some("Daily Checkin"),
            Some("2026-03-01"),
            "Met with @alex\n- [ ] call mom\nGoal: sleep before 11\nI feel anxious but grateful",
        );

        let s = extract_note_signals(&n);
        assert!(s.people.iter().any(|p| p.contains("alex")));
        assert_eq!(s.open_loops, 1);
        assert!(!s.goals.is_empty());
        assert!(s.recency_days.is_some());
    }

    #[test]
    fn infers_work_area() {
        let n = note(
            "work/roadmap.md",
            Some("Q2 roadmap"),
            Some("2026-03-01"),
            "Project launch plan for client meeting and team follow-up",
        );
        let s = extract_note_signals(&n);
        assert!(s.life_areas.contains(&LifeArea::Work));
    }

    #[test]
    fn salience_ranks_unresolved_notes_higher() {
        let a = note(
            "a.md",
            Some("Loose ends"),
            Some("2026-03-01"),
            "- [ ] file taxes\n- [ ] fix budget\nGoal: finalize finance plan",
        );
        let b = note(
            "b.md",
            Some("Read article"),
            Some("2026-03-01"),
            "Finished reading and summarized key ideas.",
        );

        let overview = build_memory_overview(&[a, b], 2);
        assert_eq!(overview.cards.len(), 2);
        assert!(overview.cards[0].salience >= overview.cards[1].salience);
        assert!(overview.cards[0].open_loops >= overview.cards[1].open_loops);
    }
}
