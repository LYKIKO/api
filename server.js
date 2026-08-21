// ============ LOAD ENVIRONMENT VARIABLES ============
require('dotenv').config();

const dns = require('dns');
// Optional fix if your local network blocks MongoDB SRV DNS lookups:
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const compression = require('compression');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 8000;

// ============ MONGODB CONNECTION ============
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://lyheangzzff_db_user:zFePd4DGONoPo3JN@sbaystores.vgxjvm2.mongodb.net/sbaystores_db?retryWrites=true&w=majority&appName=sbaystores';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('📦 Connected to MongoDB Atlas successfully'))
    .catch((err) => console.error('❌ MongoDB connection error:', err));

// Define Product Mongoose Schema
const productSchema = new mongoose.Schema({
    product_id: { type: String, required: true, unique: true, default: uuidv4 },
    product_name: { type: String, required: true, trim: true },
    product_price: { type: Number, required: true, min: 0 },
    product_image_url: { type: String, default: 'https://via.placeholder.com/300x200/111827/2563EB?text=No+Image' },
    product_category: { type: String, required: true, trim: true },
    product_description: { type: String, default: '' },
    product_stock: { type: Number, required: true, default: 0, min: 0 },
    created_at: { type: String, default: () => new Date().toISOString().replace('T', ' ').slice(0, 19) },
    updated_at: { type: String, default: null },
    stock_history: { type: Array, default: [] }
});

const Product = mongoose.model('Product', productSchema);

// ============ CLOUDFLARE R2 CONFIGURATION ============
const r2Client = new S3Client({
    region: 'auto',
    endpoint: process.env.CLOUDFLARE_R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    },
});

const R2_BUCKET = process.env.CLOUDFLARE_R2_BUCKET_NAME;
const BACKUP_PREFIX = 'backups/products/';
const MAX_BACKUPS = 10;

// ============ MIDDLEWARE ============
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ CLOUDFLARE R2 BACKUP FUNCTIONS ============
async function backupToCloudflare(data) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFileName = `products_backup_${timestamp}.json`;
        const backupKey = `${BACKUP_PREFIX}${backupFileName}`;

        const jsonData = JSON.stringify(data, null, 2);
        const buffer = Buffer.from(jsonData, 'utf8');

        const command = new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: backupKey,
            Body: buffer,
            ContentType: 'application/json',
            Metadata: {
                'backup-time': new Date().toISOString(),
                'product-count': String(data.products?.length || 0),
                'version': '2.0.0-mongo'
            }
        });

        await r2Client.send(command);
        console.log(`[Backup] Successfully uploaded backup to R2: ${backupFileName}`);
        return { success: true, fileName: backupFileName, timestamp };
    } catch (error) {
        console.error('[Backup] Failed to backup to Cloudflare R2:', error.message);
        throw error;
    }
}

async function performScheduledBackup() {
    try {
        console.log('[Backup] Performing scheduled backup from MongoDB...');
        const products = await Product.find().lean();
        const data = {
            products,
            lastUpdated: new Date().toISOString()
        };
        const result = await backupToCloudflare(data);
        return result;
    } catch (error) {
        console.error('[Backup] Scheduled backup failed:', error.message);
        return null;
    }
}

let backupInterval = null;
function startScheduledBackup() {
    if (backupInterval) clearInterval(backupInterval);
    backupInterval = setInterval(performScheduledBackup, 3600000); // Every hour
    setTimeout(performScheduledBackup, 5000); 
    console.log('[Scheduler] Hourly backup scheduler started');
}

// ============ ROUTES ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api', (req, res) => {
    res.json({
        name: 'SbayStore API (MongoDB)',
        version: '2.0.0',
        features: {
            database: 'MongoDB Atlas',
            pagination: 'Enabled',
            compression: 'gzip enabled',
            backup: 'Hourly backup to Cloudflare R2'
        }
    });
});

// ============ GET ALL PRODUCTS (WITH FILTERS, SORT & PAGINATION) ============
app.get('/api/products', async (req, res) => {
    try {
        const startTime = Date.now();
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 24, 60);
        const { search, category, minPrice, maxPrice, sort, minStock, maxStock } = req.query;

        let query = {};

        // --- FILTERS ---
        if (search) {
            query.$or = [
                { product_name: { $regex: search, $options: 'i' } },
                { product_description: { $regex: search, $options: 'i' } },
                { product_category: { $regex: search, $options: 'i' } }
            ];
        }

        if (category) {
            query.product_category = { $regex: `^${category}$`, $options: 'i' };
        }

        if (minPrice || maxPrice) {
            query.product_price = {};
            if (minPrice) query.product_price.$gte = parseFloat(minPrice);
            if (maxPrice) query.product_price.$lte = parseFloat(maxPrice);
        }

        if (minStock || maxStock) {
            query.product_stock = {};
            if (minStock) query.product_stock.$gte = parseInt(minStock);
            if (maxStock) query.product_stock.$lte = parseInt(maxStock);
        }

        // --- SORTING ---
        let sortCriteria = {};
        if (sort) {
            switch (sort) {
                case 'price_asc': sortCriteria = { product_price: 1 }; break;
                case 'price_desc': sortCriteria = { product_price: -1 }; break;
                case 'name_asc': sortCriteria = { product_name: 1 }; break;
                case 'name_desc': sortCriteria = { product_name: -1 }; break;
                case 'stock_asc': sortCriteria = { product_stock: 1 }; break;
                case 'stock_desc': sortCriteria = { product_stock: -1 }; break;
                case 'newest': sortCriteria = { created_at: -1 }; break;
                case 'oldest': sortCriteria = { created_at: 1 }; break;
                default: break;
            }
        }

        const total = await Product.countDocuments(query);
        const totalPages = Math.ceil(total / limit) || 1;
        const skip = (page - 1) * limit;

        const products = await Product.find(query)
            .sort(sortCriteria)
            .skip(skip)
            .limit(limit);

        // Fetch distinct categories for filter lists
        const categories = await Product.distinct('product_category');

        res.set({
            'X-Response-Time': `${Date.now() - startTime}ms`,
            'X-Total-Products': total,
            'X-Total-Pages': totalPages,
            'X-Current-Page': page
        });

        res.json({
            success: true,
            products,
            total,
            page,
            limit,
            totalPages,
            hasNextPage: skip + products.length < total,
            hasPrevPage: page > 1,
            categories: categories.filter(Boolean)
        });

    } catch (error) {
        console.error('[API] Error fetching products:', error);
        res.status(500).json({ success: false, message: 'Error fetching products', error: error.message });
    }
});

// ============ GET SINGLE PRODUCT ============
app.get('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findOne({ product_id: req.params.id });
        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }
        res.json({ success: true, product });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching product', error: error.message });
    }
});

// ============ CREATE PRODUCT ============
app.post('/api/products', async (req, res) => {
    try {
        const { product_name, product_price, product_image_url, product_category, product_description, product_stock } = req.body;

        if (!product_name || product_price === undefined || !product_category) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: product_name, product_price, product_category'
            });
        }

        const newProduct = new Product({
            product_id: uuidv4(),
            product_name: product_name.trim(),
            product_price: parseFloat(product_price),
            product_image_url: product_image_url || 'https://via.placeholder.com/300x200/111827/2563EB?text=No+Image',
            product_category: product_category.trim(),
            product_description: product_description || '',
            product_stock: parseInt(product_stock) || 0,
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
        });

        const savedProduct = await newProduct.save();
        res.status(201).json({ success: true, message: 'Product created successfully', product: savedProduct });
    } catch (error) {
        console.error('[API] Error creating product:', error);
        res.status(500).json({ success: false, message: 'Error creating product', error: error.message });
    }
});

// ============ ADD STOCK TO PRODUCT ============
app.post('/api/products/:id/add-stock', async (req, res) => {
    try {
        const { quantity, note } = req.body;
        const addQuantity = parseInt(quantity);

        if (!addQuantity || addQuantity <= 0) {
            return res.status(400).json({ success: false, message: 'Please provide a valid positive quantity' });
        }

        const product = await Product.findOne({ product_id: req.params.id });
        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        const oldStock = product.product_stock || 0;
        const newStock = oldStock + addQuantity;
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

        product.product_stock = newStock;
        product.updated_at = timestamp;
        product.stock_history.push({
            date: timestamp,
            quantity_added: addQuantity,
            previous_stock: oldStock,
            new_stock: newStock,
            note: note || 'Stock addition'
        });

        const updatedProduct = await product.save();
        res.json({
            success: true,
            message: `Added ${addQuantity} units to stock`,
            product: updatedProduct,
            stock_update: { previous_stock: oldStock, new_stock: newStock, quantity_added: addQuantity }
        });
    } catch (error) {
        console.error('[API] Error adding stock:', error);
        res.status(500).json({ success: false, message: 'Error adding stock', error: error.message });
    }
});

// ============ UPDATE PRODUCT ============
app.put('/api/products/:id', async (req, res) => {
    try {
        const updatedFields = req.body;
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

        const updateData = {
            ...updatedFields,
            updated_at: timestamp
        };

        const updatedProduct = await Product.findOneAndUpdate(
            { product_id: req.params.id },
            updateData,
            { new: true, runValidators: true }
        );

        if (!updatedProduct) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        res.json({ success: true, message: 'Product updated successfully', product: updatedProduct });
    } catch (error) {
        console.error('[API] Error updating product:', error);
        res.status(500).json({ success: false, message: 'Error updating product', error: error.message });
    }
});

// ============ DELETE PRODUCT ============
app.delete('/api/products/:id', async (req, res) => {
    try {
        const deletedProduct = await Product.findOneAndDelete({ product_id: req.params.id });
        if (!deletedProduct) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }
        res.json({ success: true, message: 'Product deleted successfully', product: deletedProduct });
    } catch (error) {
        console.error('[API] Error deleting product:', error);
        res.status(500).json({ success: false, message: 'Error deleting product', error: error.message });
    }
});

// ============ BULK CREATE ============
app.post('/api/products/bulk', async (req, res) => {
    try {
        const productsArray = req.body.products || [];
        if (!Array.isArray(productsArray) || productsArray.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid products array' });
        }

        const newProducts = productsArray.map(p => ({
            product_id: uuidv4(),
            product_name: p.product_name || 'Unnamed Product',
            product_price: parseFloat(p.product_price) || 0,
            product_image_url: p.product_image_url || 'https://via.placeholder.com/300x200/111827/2563EB?text=No+Image',
            product_category: p.product_category || 'Uncategorized',
            product_description: p.product_description || '',
            product_stock: parseInt(p.product_stock) || 0,
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
        }));

        const inserted = await Product.insertMany(newProducts);
        res.status(201).json({ success: true, message: `${inserted.length} products created successfully`, products: inserted });
    } catch (error) {
        console.error('[API] Error bulk creating products:', error);
        res.status(500).json({ success: false, message: 'Error bulk creating products', error: error.message });
    }
});

// ============ BACKUP STATUS & MANUAL TRIGGER ============
app.get('/api/backup/status', (req, res) => {
    res.json({
        success: true,
        backup: { enabled: true, provider: 'Cloudflare R2', bucket: R2_BUCKET, schedule: 'Hourly' }
    });
});

app.post('/api/backup/manual', async (req, res) => {
    try {
        const result = await performScheduledBackup();
        if (result) {
            res.json({ success: true, message: 'Manual backup completed successfully', backup: result });
        } else {
            res.status(500).json({ success: false, message: 'Manual backup failed' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error performing manual backup', error: error.message });
    }
});

// ============ HEALTH CHECK ============
app.get('/api/health', async (req, res) => {
    try {
        const productCount = await Product.countDocuments();
        res.json({
            status: 'healthy',
            database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
            timestamp: new Date().toISOString(),
            productCount,
            backupScheduler: backupInterval ? 'running' : 'stopped'
        });
    } catch (error) {
        res.status(500).json({ status: 'unhealthy', error: error.message });
    }
});

// ============ START SERVER ============
app.listen(PORT, () => {
    console.log(`🚀 SbayStore API v2.0 (MongoDB) running on http://localhost:${PORT}`);
    console.log(`📦 Products endpoint: http://localhost:${PORT}/api/products?page=1&limit=24`);
    
    if (R2_BUCKET && process.env.CLOUDFLARE_R2_ACCESS_KEY_ID) {
        startScheduledBackup();
    } else {
        console.warn('⚠️ Cloudflare R2 backup is not configured. Set environment variables to enable.');
    }
});
