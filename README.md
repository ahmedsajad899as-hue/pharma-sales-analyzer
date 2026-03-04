# Pharma Sales Analyzer

## Overview
Pharma Sales Analyzer is a web platform designed to allow users to upload Excel files containing pharmaceutical sales data. The application utilizes artificial intelligence to analyze the uploaded data based on predefined filters, providing users with valuable insights into their sales performance.

## Features
- **File Upload**: Users can easily upload Excel files containing sales data.
- **Data Analysis**: The application employs AI algorithms to analyze the data based on user-selected filters.
- **User Interface**: A user-friendly interface for selecting filters and viewing analysis results.

## Project Structure
```
pharma-sales-analyzer
├── src
│   ├── components
│   │   ├── FileUpload.tsx
│   │   ├── FilterPanel.tsx
│   │   └── AnalysisResults.tsx
│   ├── pages
│   │   ├── Home.tsx
│   │   └── Dashboard.tsx
│   ├── services
│   │   ├── fileService.ts
│   │   ├── aiService.ts
│   │   └── excelParser.ts
│   ├── types
│   │   └── index.ts
│   ├── utils
│   │   └── helpers.ts
│   └── App.tsx
├── public
│   └── index.html
├── package.json
├── tsconfig.json
└── README.md
```

## Getting Started

### Prerequisites
- Node.js (version 14 or higher)
- npm (Node Package Manager)

### Installation
1. Clone the repository:
   ```
   git clone https://github.com/yourusername/pharma-sales-analyzer.git
   ```
2. Navigate to the project directory:
   ```
   cd pharma-sales-analyzer
   ```
3. Install the dependencies:
   ```
   npm install
   ```

### Running the Application
To start the development server, run:
```
npm start
```
The application will be available at `http://localhost:3000`.

### Usage
1. Navigate to the Home page to upload your Excel file.
2. Use the Filter Panel to select the desired filters for analysis.
3. View the analysis results on the Dashboard page.

## Contributing
Contributions are welcome! Please open an issue or submit a pull request for any enhancements or bug fixes.

## License
This project is licensed under the MIT License. See the LICENSE file for details.

## Acknowledgments
- Thanks to the contributors and the open-source community for their support and resources.