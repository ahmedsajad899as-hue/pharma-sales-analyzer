import React from 'react';
import FileUpload from '../components/FileUpload';
import FilterPanel from '../components/FilterPanel';
import AnalysisResults from '../components/AnalysisResults';
import { useState } from 'react';

const Dashboard: React.FC = () => {
    const [analysisResults, setAnalysisResults] = useState<any>(null);
    const [filters, setFilters] = useState<any>(null);

    const handleFileUpload = (data: any) => {
        // Call AI service to analyze data based on filters
        // Assuming aiService is imported and used here
        // aiService.analyzeData(data, filters).then(results => setAnalysisResults(results));
    };

    const handleFilterChange = (newFilters: any) => {
        setFilters(newFilters);
        // Optionally trigger analysis when filters change
        // if (analysisResults) {
        //     handleFileUpload(analysisResults);
        // }
    };

    return (
        <div>
            <h1>Pharmaceutical Sales Analysis Dashboard</h1>
            <FileUpload onFileUpload={handleFileUpload} />
            <FilterPanel onFilterChange={handleFilterChange} />
            {analysisResults && <AnalysisResults data={analysisResults} />}
        </div>
    );
};

export default Dashboard;