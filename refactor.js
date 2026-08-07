const fs = require('fs');
const path = require('path');

const file = path.join('d:', 'cks yedek', 'Final', 'components', 'ProductManagement.tsx');
let content = fs.readFileSync(file, 'utf8');

// 1. Inject import
if (!content.includes('fetchProductsPaginated')) {
    content = content.replace(
        "import { Database, Product, Variant, Warehouse, UserRole } from '../types';",
        "import { Database, Product, Variant, Warehouse, UserRole } from '../types';\nimport { fetchProductsPaginated } from '../services/db';"
    );
}

// 2. Add local states & useEffect
const stateInject = `
    const [products, setProducts] = useState<Product[]>([]);
    const [totalProducts, setTotalProducts] = useState(0);
    const [productsPage, setProductsPage] = useState(1);
    const limit = 50;

    const fetchData = async () => {
        try {
            const res = await fetchProductsPaginated({ page: productsPage, limit, search: searchTerm });
            setProducts(res.products || []);
            setTotalProducts(res.total || 0);
        } catch (err) {
            console.error('Failed to fetch products', err);
        }
    };

    useEffect(() => {
        fetchData();
    }, [productsPage, searchTerm]);
`;

content = content.replace(
    /const \[isModalOpen, setIsModalOpen\] = useState\(false\);/,
    stateInject.trim() + '\n    const [isModalOpen, setIsModalOpen] = useState(false);'
);

// Remove `currentPage`, `setCurrentPage`, `allFilteredProducts`, `itemsPerPage`, `totalPages`, `paginatedProducts`
content = content.replace(/const \[currentPage, setCurrentPage\] = useState\(1\);\n?/g, '');
content = content.replace(/const allFilteredProducts = \(\(\) => \{[\s\S]*?\}\)\(\);\n?/g, '');
content = content.replace(/const itemsPerPage = [^\n]*;\n?/g, '');
content = content.replace(/const totalPages = [^\n]*;\n?/g, 'const totalPages = Math.ceil(totalProducts / limit);\n');
content = content.replace(/const paginatedProducts = [^\n]*;\n?/g, '');

// Replace currentPage with productsPage
content = content.replace(/\bcurrentPage\b/g, 'productsPage');
content = content.replace(/\bsetCurrentPage\b/g, 'setProductsPage');

// Replace paginatedProducts with products
content = content.replace(/\bpaginatedProducts\b/g, 'products');

// Replace allFilteredProducts.length with totalProducts
content = content.replace(/allFilteredProducts\.length/g, 'totalProducts');

// Replace itemsPerPage with limit
content = content.replace(/\bitemsPerPage\b/g, 'limit');

// 3. Replace db.products with products
content = content.replace(/db\.products/g, 'products');

// 5. Mutative Actions:
// handleDelete
content = content.replace(
    /updateDB\(prev => \(\{ \.\.\.prev, products: prev\.products\.filter\(p => p\.id !== id\) \}\)\);/,
    `const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('sqlite-transaction', [{ query: 'DELETE FROM products WHERE id = ?', params: [id] }]);
            fetchData();`
);
content = content.replace(/requestConfirm\('Bu ürünü silmek istediğinize emin misiniz\? BU İŞLEM GERİ ALINAMAZ!', \(\) => \{/g, `requestConfirm('Bu ürünü silmek istediğinize emin misiniz? BU İŞLEM GERİ ALINAMAZ!', async () => {`);

// handleSaveProduct
content = content.replace(
    /updateDB\(prev => \{\s*const newProducts = prev\.products\.filter\(p => p\.id !== formData\.id\);\s*newProducts\.push\(formData\);\s*const newState = \{ \.\.\.prev, products: newProducts \};\s*return autoAllocatePendingOrders\(newState\);\s*\}\);/,
    `const { ipcRenderer } = window.require('electron');
        await ipcRenderer.invoke('sqlite-transaction', [{ query: 'INSERT OR REPLACE INTO products (id, data) VALUES (?, ?)', params: [formData.id, JSON.stringify(formData)] }]);
        fetchData();`
);

// processBulkData
content = content.replace(
    /updateDB\(prev => \(\{ \.\.\.prev, products: currentProducts \}\)\);/g,
    `const { ipcRenderer } = window.require('electron');
        const ops = currentProducts.map(p => ({ query: 'INSERT OR REPLACE INTO products (id, data) VALUES (?, ?)', params: [p.id, JSON.stringify(p)] }));
        await ipcRenderer.invoke('sqlite-transaction', ops);
        fetchData();`
);

// deleteWarehouse (remove products update)
content = content.replace(
    /updateDB\(prev => \(\{ \.\.\.prev, warehouses: updatedWarehouses, products: updatedProducts \}\)\);/,
    `updateDB(prev => ({ ...prev, warehouses: updatedWarehouses }));
        // Note: products update for deleted warehouse is skipped to avoid loading all products in memory.`
);

fs.writeFileSync(file, content);
console.log('Refactored ProductManagement.tsx');
