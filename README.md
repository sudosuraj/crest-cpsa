# CREST CPSA Practice Quiz

A free, open-source practice quiz application for CREST CPSA (Practitioner Security Analyst) certification preparation. Features dynamic AI-generated questions from study materials using RAG (Retrieval-Augmented Generation).

## Features

- **Dynamic Question Generation**: AI-powered question generation from CPSA study materials using RAG
- **10 Appendix Categories**: Questions organized by CPSA exam appendices (A-J)
- **Concurrent Processing**: Fast question loading with parallel batch processing (5 concurrent API calls)
- **Background Preloading**: All appendixes preload questions in the background for instant access
- **AI-Powered Explanations**: Get detailed explanations for questions using AI
- **Progress Tracking**: Your progress is automatically saved in your browser
- **Practice Exams**: Timed exam simulations with configurable question count and category filters
- **Gamification**: Earn XP, badges, and track your study streak
- **Review Mode**: Focus on questions you've answered incorrectly
- **Offline Support**: Works offline as a Progressive Web App (PWA)
- **Mobile Responsive**: Works on desktop and mobile devices
- **Challenge Mode**: Share quiz challenges with friends via URL
- **Compact UI**: Streamlined navbar design that doesn't dominate the screen
- **Prominent Navigation**: Clear "Next" button with visual indicators for pagination

## Appendices Covered

The quiz covers all 10 CPSA exam appendices:

- **Appendix A**: Soft Skills and Assessment Management
- **Appendix B**: Core Technical Skills
- **Appendix C**: Background Information Gathering and Open Source Intelligence
- **Appendix D**: Networking Equipment
- **Appendix E**: Microsoft Windows Security Assessment
- **Appendix F**: Unix Security Assessment
- **Appendix G**: Web Technologies
- **Appendix H**: Web Testing Techniques
- **Appendix I**: Databases
- **Appendix J**: Web Application Servers

## Technical Architecture

### RAG-Based Question Generation
The application uses Retrieval-Augmented Generation (RAG) to dynamically generate quiz questions from CPSA study materials:

1. **BM25 Search**: Client-side BM25 algorithm indexes and searches study material chunks
2. **LLM Integration**: Questions are generated via API calls to GPT-4o-mini
3. **Deduplication**: FNV-1a hashing prevents duplicate questions
4. **Token Budgeting**: Stays within 8000 token API limits

### Concurrent Processing
For optimal performance, the system uses concurrent queue patterns:

- **Preloading**: 3 concurrent appendix preloads (`PRELOAD_CONCURRENCY = 3`)
- **Question Generation**: 5 concurrent chunk API calls per batch (`BATCH_CONCURRENCY = 5`)
- **Background Loading**: Next batch loads while user answers current questions

## Usage

Visit [https://sudosuraj.github.io/crest-cpsa/](https://sudosuraj.github.io/crest-cpsa/) to start practicing.

The quiz can also be installed as a PWA on your device for offline access.

## Local Development

Simply open `index.html` in a web browser. No build process or dependencies required.

For PWA features to work locally, you'll need to serve the files over HTTP:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`

## Contributing

Contributions are welcome! Feel free to:
- Report bugs or suggest features via GitHub Issues
- Submit pull requests with improvements
- Add or improve quiz questions

## License

This project is open source and available under the MIT License.

## Author

Created by [Suraj Sharma (sudosuraj)](https://www.linkedin.com/in/sudosuraj/)

- GitHub: [@sudosuraj](https://github.com/sudosuraj)
- Blog: [sudosuraj.medium.com](https://sudosuraj.medium.com)
- Twitter: [@sudosuraj](https://twitter.com/sudosuraj)

## Credits

### Contributors
- **[Ravi Solanki](https://www.linkedin.com/in/ravi-solanki-876089132/)** - Document and study materials
- **[Suraj Sharma](https://www.linkedin.com/in/sudosuraj)** - Platform development

### Development Assistance
- UI improvements, concurrent processing implementation, and background preloading features developed with assistance from [Devin AI](https://devin.ai)

### Technologies Used
- **LLM API**: [llm7.io](https://llm7.io) - GPT-4o-mini for question generation and explanations
- **Search Algorithm**: BM25 (Best Matching 25) for client-side document retrieval
- **Storage**: IndexedDB for caching questions and RAG index data
- **PWA**: Service Worker for offline functionality
