#!/usr/bin/env python3
"""
Regenerate chunks.json with improved chunking strategy for better RAG coverage.

Improvements:
1. Merge small chunks (<200 chars) with neighbors instead of creating tiny chunks
2. Split large chunks (>2000 chars) with 200-char overlap for context continuity
3. Filter out "Missing from syllabus" placeholder content
4. Preserve section boundaries where possible
5. Target chunk size: 800-1500 chars for optimal LLM context
"""

import json
import os
import re
from pathlib import Path

# Configuration
TARGET_CHUNK_SIZE = 1200  # Target size for chunks
MIN_CHUNK_SIZE = 200      # Minimum chunk size (merge smaller ones)
MAX_CHUNK_SIZE = 2000     # Maximum chunk size (split larger ones)
OVERLAP_SIZE = 200        # Overlap when splitting large chunks

# Patterns to filter out
PLACEHOLDER_PATTERNS = [
    r'Missing from the official CREST CPSA syllabus',
    r'\[placeholder\]',
    r'\[to be added\]',
    r'\[section missing\]',
]

def is_placeholder_content(text):
    """Check if content is just a placeholder."""
    text_lower = text.lower().strip()
    for pattern in PLACEHOLDER_PATTERNS:
        if re.search(pattern, text_lower, re.IGNORECASE):
            # Only filter if the entire content is basically just the placeholder
            if len(text.strip()) < 100:
                return True
    return False

def split_into_paragraphs(text):
    """Split text into paragraphs while preserving structure."""
    # Split on double newlines or section headers
    paragraphs = re.split(r'\n\s*\n|\n(?=[A-Z][a-z]+ [A-Z]|\d+\.|\•)', text)
    return [p.strip() for p in paragraphs if p.strip()]

def create_chunks_from_section(section_content, section_id, section_title, appendix, appendix_title):
    """Create optimally-sized chunks from a section."""
    chunks = []
    
    # Skip placeholder content
    if is_placeholder_content(section_content):
        print(f"  Skipping placeholder section: {section_id}")
        return chunks
    
    # If section is small enough, keep as single chunk
    if len(section_content) <= MAX_CHUNK_SIZE:
        if len(section_content) >= MIN_CHUNK_SIZE:
            chunks.append({
                'text': section_content,
                'section_id': section_id,
                'section_title': section_title,
                'appendix': appendix,
                'appendix_title': appendix_title
            })
        return chunks
    
    # Split large sections into overlapping chunks
    paragraphs = split_into_paragraphs(section_content)
    current_chunk = ""
    
    for para in paragraphs:
        # If adding this paragraph would exceed max size, save current chunk
        if len(current_chunk) + len(para) + 2 > MAX_CHUNK_SIZE and len(current_chunk) >= MIN_CHUNK_SIZE:
            chunks.append({
                'text': current_chunk.strip(),
                'section_id': section_id,
                'section_title': section_title,
                'appendix': appendix,
                'appendix_title': appendix_title
            })
            # Start new chunk with overlap from end of previous
            overlap_text = current_chunk[-OVERLAP_SIZE:] if len(current_chunk) > OVERLAP_SIZE else ""
            current_chunk = overlap_text + "\n\n" + para if overlap_text else para
        else:
            current_chunk = current_chunk + "\n\n" + para if current_chunk else para
    
    # Don't forget the last chunk
    if current_chunk.strip() and len(current_chunk.strip()) >= MIN_CHUNK_SIZE:
        chunks.append({
            'text': current_chunk.strip(),
            'section_id': section_id,
            'section_title': section_title,
            'appendix': appendix,
            'appendix_title': appendix_title
        })
    elif current_chunk.strip() and chunks:
        # Merge tiny last chunk with previous
        chunks[-1]['text'] += "\n\n" + current_chunk.strip()
    
    return chunks

def process_appendix(appendix_file):
    """Process a single appendix JSON file."""
    with open(appendix_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    appendix = data['letter']
    appendix_title = data['title']
    chunks = []
    
    print(f"\nProcessing {appendix}: {appendix_title}")
    
    for section in data['sections']:
        section_id = section['id']
        section_title = section['title']
        section_content = section['content']
        
        section_chunks = create_chunks_from_section(
            section_content, section_id, section_title, appendix, appendix_title
        )
        
        if section_chunks:
            print(f"  {section_id}: {len(section_content)} chars -> {len(section_chunks)} chunks")
            chunks.extend(section_chunks)
    
    return chunks

def merge_small_chunks(chunks):
    """Merge consecutive small chunks from the same section."""
    if not chunks:
        return chunks
    
    merged = []
    current = None
    
    for chunk in chunks:
        if current is None:
            current = chunk.copy()
            continue
        
        # If same section and combining would be under max size
        if (current['section_id'] == chunk['section_id'] and 
            len(current['text']) + len(chunk['text']) + 2 <= MAX_CHUNK_SIZE):
            # Merge
            current['text'] = current['text'] + "\n\n" + chunk['text']
        else:
            # Save current and start new
            if len(current['text']) >= MIN_CHUNK_SIZE:
                merged.append(current)
            current = chunk.copy()
    
    # Don't forget last chunk
    if current and len(current['text']) >= MIN_CHUNK_SIZE:
        merged.append(current)
    
    return merged

def main():
    script_dir = Path(__file__).parent
    rag_dir = script_dir.parent / 'rag'
    appendices_dir = rag_dir / 'appendices'
    
    all_chunks = []
    
    # Process each appendix
    for appendix_file in sorted(appendices_dir.glob('*.json')):
        chunks = process_appendix(appendix_file)
        all_chunks.extend(chunks)
    
    # Merge any remaining small chunks
    all_chunks = merge_small_chunks(all_chunks)
    
    # Add IDs
    for i, chunk in enumerate(all_chunks):
        chunk['id'] = f'chunk_{i}'
    
    # Calculate statistics
    total_chars = sum(len(c['text']) for c in all_chunks)
    avg_size = total_chars / len(all_chunks) if all_chunks else 0
    min_size = min(len(c['text']) for c in all_chunks) if all_chunks else 0
    max_size = max(len(c['text']) for c in all_chunks) if all_chunks else 0
    
    print(f"\n=== Summary ===")
    print(f"Total chunks: {len(all_chunks)}")
    print(f"Total characters: {total_chars}")
    print(f"Average chunk size: {avg_size:.0f} chars")
    print(f"Min chunk size: {min_size} chars")
    print(f"Max chunk size: {max_size} chars")
    
    # Count by appendix
    appendix_counts = {}
    for chunk in all_chunks:
        app = chunk['appendix']
        appendix_counts[app] = appendix_counts.get(app, 0) + 1
    
    print(f"\nChunks by appendix:")
    for app in sorted(appendix_counts.keys()):
        print(f"  {app}: {appendix_counts[app]} chunks")
    
    # Write output
    output_file = rag_dir / 'chunks.json'
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(all_chunks, f, indent=2, ensure_ascii=False)
    
    print(f"\nWritten to: {output_file}")

if __name__ == '__main__':
    main()
