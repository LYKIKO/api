const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 8000;

// ============ MIDDLEWARE ============
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ============ DATA MANAGEMENT ============
const DATA_FILE = path.join(__dirname, 'data', 'products.json');
let productsCache = null;
let cacheTimestamp = null;
const CACHE_TTL = 5000; // 5 seconds

// File watcher for external changes
let watcherInitialized = false;

function initializeFileWatcher() {
    if (watcherInitialized) return;
    try {
        fs.watch(DATA_FILE, (eventType) => {
            if (eventType === 'change') {
                console.log('[Cache] File changed, clearing cache...');
                productsCache = null;
                cacheTimestamp = null;
            }
        });
        watcherInitialized = true;
        console.log('[Cache] File watcher initialized');
    } catch (error) {
        console.error('[Cache] Failed to initialize watcher:', error.message);
    }
}

function readData() {
    // Return cached data if valid
    if (productsCache && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_TTL)) {
        return productsCache;
    }

    try {
        if (!fs.existsSync(DATA_FILE)) {
            const defaultData = { products: [], lastUpdated: new Date().toISOString() };
            fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
            productsCache = defaultData;
            cacheTimestamp = Date.now();
            initializeFileWatcher();
            return defaultData;
        }

        const data = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        // Ensure products is always an array
        if (!Array.isArray(parsed.products)) {
            parsed.products = [];
        }
        
        productsCache = parsed;
        cacheTimestamp = Date.now();
        initializeFileWatcher();
        return parsed;
    } catch (error) {
        console.error('[Data] Error reading file:', error);
        return { products: [] };
    }
}

// Async write with retry
async function writeData(data) {
    try {
        // Ensure directory exists
        const dir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write to temp file first
        const tempFile = DATA_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
        
        // Atomic rename
        fs.renameSync(tempFile, DATA_FILE);
        
        // Update cache
        productsCache = data;
        cacheTimestamp = Date.now();
        return true;
    } catch (error) {
        console.error('[Data] Error writing file:', error);
        return false;
    }
}

// ============ HELPERS ============
function generateProductId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 15; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function paginateArray(array, page = 1, limit = 24) {
    const start = (page - 1) * limit;
    const end = start + limit;
    const paginated = array.slice(start, end);
    return {
        products: paginated,
        total: array.length,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(array.length / limit),
        hasNextPage: end < array.length,
        hasPrevPage: page > 1
    };
}

// ============ ROUTES ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api', (req, res) => {
    res.json({
        name: 'SbayStore API',
        version: '2.0.0',
        features: {
            pagination: '24 products per page',
            caching: '5-second response cache',
            compression: 'gzip enabled',
            stockManagement: 'Add and update stock'
        },
        endpoints: {
            products: '/api/products?page=1&limit=24',
            product: '/api/products/:id',
            create: '/api/products (POST)',
            update: '/api/products/:id (PUT)',
            delete: '/api/products/:id (DELETE)',
            addStock: '/api/products/:id/add-stock (POST)',
            bulkAdd: '/api/products/bulk (POST)'
        }
    });
});

// ============ GET ALL PRODUCTS (WITH PAGINATION) ============
app.get('/api/products', (req, res) => {
    try {
        const startTime = Date.now();
        const data = readData();

        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 24, 60);
        const { search, category, minPrice, maxPrice, sort, minStock, maxStock } = req.query;
        
        let products = data.products || [];

        // --- FILTERS ---
        if (search) {
            const searchLower = search.toLowerCase();
            products = products.filter(p => 
                (p.product_name || '').toLowerCase().includes(searchLower) ||
                (p.product_description || '').toLowerCase().includes(searchLower) ||
                (p.product_category || '').toLowerCase().includes(searchLower)
            );
        }

        if (category) {
            products = products.filter(p => 
                (p.product_category || '').toLowerCase() === category.toLowerCase()
            );
        }

        if (minPrice) {
            products = products.filter(p => (p.product_price || 0) >= parseFloat(minPrice));
        }
        if (maxPrice) {
            products = products.filter(p => (p.product_price || 0) <= parseFloat(maxPrice));
        }

        if (minStock) {
            products = products.filter(p => (p.product_stock || 0) >= parseInt(minStock));
        }
        if (maxStock) {
            products = products.filter(p => (p.product_stock || 0) <= parseInt(maxStock));
        }

        // --- SORT ---
        if (sort) {
            switch(sort) {
                case 'price_asc': products.sort((a, b) => (a.product_price || 0) - (b.product_price || 0)); break;
                case 'price_desc': products.sort((a, b) => (b.product_price || 0) - (a.product_price || 0)); break;
                case 'name_asc': products.sort((a, b) => (a.product_name || '').localeCompare(b.product_name || '')); break;
                case 'name_desc': products.sort((a, b) => (b.product_name || '').localeCompare(a.product_name || '')); break;
                case 'stock_asc': products.sort((a, b) => (a.product_stock || 0) - (b.product_stock || 0)); break;
                case 'stock_desc': products.sort((a, b) => (b.product_stock || 0) - (a.product_stock || 0)); break;
                case 'newest': products.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)); break;
                case 'oldest': products.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)); break;
                default: break;
            }
        }

        // --- PAGINATION ---
        const result = paginateArray(products, page, limit);

        res.set({
            'Cache-Control': 'public, max-age=5',
            'X-Response-Time': `${Date.now() - startTime}ms`,
            'X-Total-Products': result.total,
            'X-Total-Pages': result.totalPages,
            'X-Current-Page': result.page
        });

        res.json({
            success: true,
            ...result,
            categories: [...new Set(data.products.map(p => p.product_category).filter(Boolean))]
        });

    } catch (error) {
        console.error('[API] Error fetching products:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching products',
            error: error.message
        });
    }
});

// ============ GET SINGLE PRODUCT ============
app.get('/api/products/:id', (req, res) => {
    try {
        const data = readData();
        const product = data.products.find(p => p.product_id === req.params.id);

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        res.json({
            success: true,
            product: product
        });
    } catch (error) {
        console.error('[API] Error fetching product:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching product',
            error: error.message
        });
    }
});

// ============ CREATE PRODUCT ============
app.post('/api/products', async (req, res) => {
    try {
        const data = readData();
        const {
            product_name,
            product_price,
            product_image_url,
            product_category,
            product_description,
            product_stock
        } = req.body;

        // Validation
        if (!product_name || product_price === undefined || !product_category) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: product_name, product_price, product_category'
            });
        }

        const newProduct = {
            product_id: generateProductId(),
            product_name: product_name.trim(),
            product_price: parseFloat(product_price),
            product_image_url: product_image_url || 'https://via.placeholder.com/300x200/111827/2563EB?text=No+Image',
            product_category: product_category.trim(),
            product_description: product_description || '',
            product_stock: parseInt(product_stock) || 0,
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
        };

        data.products.push(newProduct);
        data.lastUpdated = new Date().toISOString();

        if (await writeData(data)) {
            res.status(201).json({
                success: true,
                message: 'Product created successfully',
                product: newProduct
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to save product'
            });
        }
    } catch (error) {
        console.error('[API] Error creating product:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating product',
            error: error.message
        });
    }
});

// ============ ADD STOCK TO PRODUCT ============
app.post('/api/products/:id/add-stock', async (req, res) => {
    try {
        const data = readData();
        const productIndex = data.products.findIndex(p => p.product_id === req.params.id);

        if (productIndex === -1) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        const { quantity, note } = req.body;
        const addQuantity = parseInt(quantity);

        if (!addQuantity || addQuantity <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a valid quantity to add (positive number)'
            });
        }

        const existingProduct = data.products[productIndex];
        const oldStock = existingProduct.product_stock || 0;
        const newStock = oldStock + addQuantity;

        // Update product stock
        data.products[productIndex] = {
            ...existingProduct,
            product_stock: newStock,
            updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
            stock_history: [
                ...(existingProduct.stock_history || []),
                {
                    date: new Date().toISOString().replace('T', ' ').slice(0, 19),
                    quantity_added: addQuantity,
                    previous_stock: oldStock,
                    new_stock: newStock,
                    note: note || 'Stock addition'
                }
            ]
        };

        data.lastUpdated = new Date().toISOString();

        if (await writeData(data)) {
            res.json({
                success: true,
                message: `Added ${addQuantity} units to stock`,
                product: data.products[productIndex],
                stock_update: {
                    previous_stock: oldStock,
                    new_stock: newStock,
                    quantity_added: addQuantity
                }
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to update stock'
            });
        }
    } catch (error) {
        console.error('[API] Error adding stock:', error);
        res.status(500).json({
            success: false,
            message: 'Error adding stock',
            error: error.message
        });
    }
});

// ============ UPDATE PRODUCT ============
app.put('/api/products/:id', async (req, res) => {
    try {
        const data = readData();
        const productIndex = data.products.findIndex(p => p.product_id === req.params.id);

        if (productIndex === -1) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        const updatedFields = req.body;
        const existingProduct = data.products[productIndex];

        data.products[productIndex] = {
            ...existingProduct,
            product_name: updatedFields.product_name || existingProduct.product_name,
            product_price: updatedFields.product_price ? parseFloat(updatedFields.product_price) : existingProduct.product_price,
            product_image_url: updatedFields.product_image_url || existingProduct.product_image_url,
            product_category: updatedFields.product_category || existingProduct.product_category,
            product_description: updatedFields.product_description || existingProduct.product_description,
            product_stock: updatedFields.product_stock !== undefined ? parseInt(updatedFields.product_stock) : existingProduct.product_stock,
            updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
        };

        data.lastUpdated = new Date().toISOString();

        if (await writeData(data)) {
            res.json({
                success: true,
                message: 'Product updated successfully',
                product: data.products[productIndex]
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to update product'
            });
        }
    } catch (error) {
        console.error('[API] Error updating product:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating product',
            error: error.message
        });
    }
});

// ============ DELETE PRODUCT ============
app.delete('/api/products/:id', async (req, res) => {
    try {
        const data = readData();
        const productIndex = data.products.findIndex(p => p.product_id === req.params.id);

        if (productIndex === -1) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        const deletedProduct = data.products[productIndex];
        data.products.splice(productIndex, 1);
        data.lastUpdated = new Date().toISOString();

        if (await writeData(data)) {
            res.json({
                success: true,
                message: 'Product deleted successfully',
                product: deletedProduct
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to delete product'
            });
        }
    } catch (error) {
        console.error('[API] Error deleting product:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting product',
            error: error.message
        });
    }
});

// ============ BULK CREATE ============
app.post('/api/products/bulk', async (req, res) => {
    try {
        const data = readData();
        const products = req.body.products || [];

        if (!Array.isArray(products) || products.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid products array'
            });
        }

        const newProducts = products.map(p => ({
            product_id: generateProductId(),
            product_name: p.product_name || 'Unnamed Product',
            product_price: parseFloat(p.product_price) || 0,
            product_image_url: p.product_image_url || 'https://via.placeholder.com/300x200/111827/2563EB?text=No+Image',
            product_category: p.product_category || 'Uncategorized',
            product_description: p.product_description || '',
            product_stock: parseInt(p.product_stock) || 0,
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
        }));

        data.products.push(...newProducts);
        data.lastUpdated = new Date().toISOString();

        if (await writeData(data)) {
            res.status(201).json({
                success: true,
                message: `${newProducts.length} products created successfully`,
                products: newProducts
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Failed to save products'
            });
        }
    } catch (error) {
        console.error('[API] Error bulk creating products:', error);
        res.status(500).json({
            success: false,
            message: 'Error bulk creating products',
            error: error.message
        });
    }
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    const data = readData();
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        productCount: data.products.length,
        cacheAge: cacheTimestamp ? `${Date.now() - cacheTimestamp}ms` : 'none'
    });
});

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log(`🚀 SbayStore API v2.0 running on http://localhost:${PORT}`);
    console.log(`📊 Data file: ${DATA_FILE}`);
    console.log(`📦 Products endpoint: http://localhost:${PORT}/api/products?page=1&limit=24`);
    console.log(`💾 Cache TTL: ${CACHE_TTL}ms`);
    console.log(`🔄 File watcher: ${watcherInitialized ? 'active' : 'initializing...'}`);
    console.log(`🌐 UI available at: http://localhost:${PORT}`);
});
