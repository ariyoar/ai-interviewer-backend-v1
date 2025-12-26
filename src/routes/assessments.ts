import express from 'express';
import { AssessmentService } from '../services/AssessmentService';

const router = express.Router();

// POST /api/assessments/coaching
router.post('/coaching', async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: "sessionId is required" });
        }

        const assessment = await AssessmentService.generateCoachingAssessment(sessionId);
        res.json(assessment);

    } catch (error: any) {
        console.error("Coaching Assessment Error:", error);
        res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});

// POST /api/assessments/screening
router.post('/screening', async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: "sessionId is required" });
        }

        const assessment = await AssessmentService.generateScreeningAssessment(sessionId);
        res.json(assessment);

    } catch (error: any) {
        console.error("Screening Assessment Error:", error);
        res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});

export default router;
