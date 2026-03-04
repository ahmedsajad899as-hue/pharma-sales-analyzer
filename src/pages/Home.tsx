import React from 'react';

const Home: React.FC = () => {
    return (
        <div>
            <h1>Welcome to the Pharma Sales Analyzer</h1>
            <p>
                This platform allows you to upload Excel files containing pharmaceutical sales data.
                You can analyze the data using various filters to gain insights into your sales performance.
            </p>
            <p>
                Navigate to the Dashboard to start analyzing your data after uploading your files.
            </p>
        </div>
    );
};

export default Home;