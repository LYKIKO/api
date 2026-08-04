const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Data file path
const DATA_FILE = path.join(__dirname, 'data', 'products.json');

// Helper functions
const readData = () => {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            // Create default data if file doesn't exist
            const defaultData = {
                products: [],
                lastUpdated: new Date().toISOString()
            };
            fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
            return defaultData;
        }
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading data file:', error);
        return { products: [] };
    }
};

const writeData = (data) => {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing data file:', error);
        return false;
    }
};

// Generate random product ID (15 characters)
const generateProductId = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 15; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

// Routes
app.get('/', (req, res) => {
    res.json({
        name: 'SbayStore API',
        version: '1.0.0',
        endpoints: {
            products: '/api/products',
            product: '/api/products/:id',
            create: '/api/products (POST)',
            update: '/api/products/:id (PUT)',
            delete: '/api/products/:id (DELETE)'
        }
    });
});

// Get all products
app.get('/api/products', (req, res) => {
    try {
        const data = readData();
        const { search, category, minPrice, maxPrice, sort } = req.query;
        
        let products = data.products || [];

        // Search filter
        if (search) {
            const searchLower = search.toLowerCase();
            products = products.filter(p => 
                p.product_name.toLowerCase().includes(searchLower) ||
                p.product_description.toLowerCase().includes(searchLower) ||
                p.product_category.toLowerCase().includes(searchLower)
            );
        }

        // Category filter
        if (category) {
            products = products.filter(p => 
                p.product_category.toLowerCase() === category.toLowerCase()
            );
        }

        // Price range filter
        if (minPrice) {
            products = products.filter(p => p.product_price >= parseFloat(minPrice));
        }
        if (maxPrice) {
            products = products.filter(p => p.product_price <= parseFloat(maxPrice));
        }

        // Sort
        if (sort) {
            switch(sort) {
                case 'price_asc':
                    products.sort((a, b) => a.product_price - b.product_price);
                    break;
                case 'price_desc':
                    products.sort((a, b) => b.product_price - a.product_price);
                    break;
                case 'name_asc':
                    products.sort((a, b) => a.product_name.localeCompare(b.product_name));
                    break;
                case 'name_desc':
                    products.sort((a, b) => b.product_name.localeCompare(a.product_name));
                    break;
                case 'newest':
                    products.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                    break;
                case 'oldest':
                    products.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                    break;
                default:
                    break;
            }
        }

        res.json({
            success: true,
            total: products.length,
            products: products
        });
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching products',
            error: error.message
        });
    }
});

// Get single product by ID
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
        console.error('Error fetching product:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching product',
            error: error.message
        });
    }
});

// Create new product
app.post('/api/products', (req, res) => {
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
        if (!product_name || !product_price || !product_category) {
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

        if (writeData(data)) {
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
        console.error('Error creating product:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating product',
            error: error.message
        });
    }
});

// Update product
app.put('/api/products/:id', (req, res) => {
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

        // Update only provided fields
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

        if (writeData(data)) {
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
        console.error('Error updating product:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating product',
            error: error.message
        });
    }
});

// Delete product
app.delete('/api/products/:id', (req, res) => {
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

        if (writeData(data)) {
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
        console.error('Error deleting product:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting product',
            error: error.message
        });
    }
});

// Bulk create products (for seeding)
app.post('/api/products/bulk', (req, res) => {
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
            product_name: p.product_name,
            product_price: parseFloat(p.product_price) || 0,
            product_image_url: p.product_image_url || 'https://via.placeholder.com/300x200/111827/2563EB?text=No+Image',
            product_category: p.product_category || 'Uncategorized',
            product_description: p.product_description || '',
            product_stock: parseInt(p.product_stock) || 0,
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
        }));

        data.products.push(...newProducts);
        data.lastUpdated = new Date().toISOString();

        if (writeData(data)) {
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
        console.error('Error bulk creating products:', error);
        res.status(500).json({
            success: false,
            message: 'Error bulk creating products',
            error: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 SbayStore API running on http://localhost:${PORT}`);
    console.log(`📊 Data file: ${DATA_FILE}`);
    console.log(`📦 Products endpoint: http://localhost:${PORT}/api/products`);
});