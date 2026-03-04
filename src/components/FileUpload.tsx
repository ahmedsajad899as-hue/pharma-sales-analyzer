import { useState } from 'react';
import axios from 'axios';

interface UploadProps {
  onSuccess: (data: any[], columns: string[]) => void;
  onError: (error: string) => void;
}

export function FileUpload({ onSuccess, onError }: UploadProps) {
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setFileName(file.name);
    
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post('/api/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      onSuccess(response.data.data, response.data.columns);
    } catch (error: any) {
      onError(error.response?.data?.error || 'خطأ في رفع الملف');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md border-2 border-dashed border-blue-300">
      <h3 className="text-lg font-bold mb-4">رفع ملف Excel</h3>
      <input 
        type="file" 
        accept=".xlsx,.csv,.xls" 
        onChange={handleFileChange}
        disabled={loading}
        className="w-full p-3 border rounded cursor-pointer"
      />
      {fileName && <p className="mt-2 text-sm text-gray-600">الملف المختار: {fileName}</p>}
      {loading && <p className="mt-2 text-blue-600">جاري رفع الملف...</p>}
    </div>
  );
}

export default FileUpload;